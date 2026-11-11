/**
 * Sending forwarded messages: one ordinary send per message per chat, through
 * the same outbox and optimistic path as typing, so each one shows up in its
 * chat with its own pending / failed state and a Retry.
 */
import type { OutgoingAttachment, OutgoingLinkPreview } from '@/core/backend';
import {
  attachmentProblem,
  attachmentProblemMessage,
  type ConversationId,
  type StickerContent,
} from '@/core/domain';
import { createLogger } from '@/core/lib';
import { selectMessageRequestState } from '@/core/stores';
import { ensureDirectConversation } from '@/ui/features/conversation';
import type { AppServices } from '@/ui/hooks';
import type { ForwardTarget } from './model';

const log = createLogger('ui');

/** A file ready to go out: its bytes are in hand. */
export interface ForwardFile {
  fileName: string;
  contentType: string;
  data: Blob;
  width?: number;
  height?: number;
  voiceNote?: boolean;
}

export interface ForwardLinkPreview {
  url: string;
  title: string;
  description?: string;
  image?: { contentType: string; data: Blob; width?: number; height?: number };
}

/** One message to forward, as it will be sent. */
export type ForwardItem = {
  /** Names the message across tries (a retry skips what already went); the position stands in if absent. */
  id?: string;
} & (
  | { kind: 'sticker'; sticker: StickerContent }
  | { kind: 'message'; text: string; files: ForwardFile[]; preview?: ForwardLinkPreview }
);

/** What identifies an item across tries. */
export const itemKey = (item: ForwardItem, index: number): string => item.id ?? `#${index}`;

/**
 * How one chat went. `delivered` names the items that are in it by now (all
 * of them when `ok`), so a retry can send just the rest; `sent` counts them.
 */
export type TargetResult =
  | { id: ConversationId; ok: true; sent: number; delivered: string[] }
  | { id: ConversationId; ok: false; reason: string; sent: number; delivered: string[] };

/** A raster image or a voice note shows its own picture on the unsent message, as the composer's do. */
const showsLocalPreview = (file: ForwardFile): boolean =>
  file.voiceNote === true ||
  (file.contentType.startsWith('image/') && file.contentType !== 'image/svg+xml');

/** A fresh object URL for one send: SendService releases it once the transport has its own. */
const objectUrl = (blob: Blob): string | undefined =>
  typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : undefined;

function outgoingFile(file: ForwardFile): OutgoingAttachment {
  const previewUrl = showsLocalPreview(file) ? objectUrl(file.data) : undefined;
  return {
    fileName: file.fileName,
    contentType: file.contentType,
    data: file.data,
    ...(previewUrl ? { previewUrl } : {}),
    ...(file.voiceNote ? { voiceNote: true } : {}),
    ...(file.width !== undefined && file.height !== undefined
      ? { width: file.width, height: file.height }
      : {}),
  };
}

function outgoingPreview(preview: ForwardLinkPreview): OutgoingLinkPreview {
  const { image } = preview;
  const previewUrl = image ? objectUrl(image.data) : undefined;
  return {
    url: preview.url,
    title: preview.title,
    ...(preview.description ? { description: preview.description } : {}),
    ...(image
      ? {
          image: {
            contentType: image.contentType,
            data: image.data,
            ...(previewUrl ? { previewUrl } : {}),
            ...(image.width !== undefined ? { width: image.width } : {}),
            ...(image.height !== undefined ? { height: image.height } : {}),
          },
        }
      : {}),
  };
}

const fail = (
  id: ConversationId,
  reason: string,
  delivered: ReadonlySet<string>,
): TargetResult => ({
  id,
  ok: false,
  reason,
  sent: delivered.size,
  delivered: [...delivered],
});

/**
 * Sends `items`, in order, to one chat. A contact with no chat yet gets one
 * (nothing is opened); a message request is accepted first, which is what
 * writing to it does. Never rejects: a send that can't start says why.
 * `alreadySent` names items to skip (a retry after some went through); the
 * result counts them with the rest.
 */
export async function forwardToTarget(
  app: AppServices,
  target: ForwardTarget,
  items: readonly ForwardItem[],
  alreadySent: ReadonlySet<string> = new Set(),
): Promise<TargetResult> {
  const keys = items.map(itemKey);
  const delivered = new Set(keys.filter((k) => alreadySent.has(k)));
  try {
    let id = target.id;
    if (!target.view && !app.stores.conversations.getState().byId[id]) {
      if (!target.contact) return fail(id, "This chat isn't available.", delivered);
      id = ensureDirectConversation(app, target.contact);
    }
    if (selectMessageRequestState(app.stores, id) === 'request' && !(await app.requests.accept(id)))
      return fail(id, "Couldn't accept the message request.", delivered);
    for (const [index, item] of items.entries()) {
      const key = itemKey(item, index);
      if (delivered.has(key)) continue;
      // Sent messages only appear in a window anchored to the present.
      const window = app.stores.messages.getState().windows[id];
      if (window && !window.anchoredToPresent) await app.history.jumpToPresent(id);
      if (item.kind === 'sticker') {
        await app.send.sendSticker({ conversationId: id, sticker: item.sticker });
        delivered.add(key);
        continue;
      }
      for (const file of item.files) {
        const problem = attachmentProblem({ size: file.data.size, name: file.fileName });
        if (problem) return fail(id, attachmentProblemMessage(file.fileName, problem), delivered);
      }
      const nonce = await app.send.send({
        conversationId: id,
        text: item.text,
        mentionIds: [],
        attachments: item.files.map(outgoingFile),
        // The text is markdown made from the message, whatever the user's own markdown setting.
        format: 'markdown',
        ...(item.preview ? { preview: outgoingPreview(item.preview) } : {}),
      });
      if (nonce === null) return fail(id, 'There was nothing to send.', delivered);
      delivered.add(key);
    }
    return { id, ok: true, sent: delivered.size, delivered: [...delivered] };
  } catch {
    // Never what was in the message: only that it failed.
    log.warn('forwarding to a chat failed');
    return fail(target.id, "Couldn't send.", delivered);
  }
}

/**
 * Sends to every target at once; each chat keeps the messages' order.
 * `progress` names the items each chat already has from an earlier try.
 */
export function forwardToTargets(
  app: AppServices,
  targets: readonly ForwardTarget[],
  items: readonly ForwardItem[],
  progress: ReadonlyMap<ConversationId, ReadonlySet<string>> = new Map(),
): Promise<TargetResult[]> {
  return Promise.all(
    targets.map((target) =>
      forwardToTarget(app, target, items, progress.get(target.id) ?? new Set<string>()),
    ),
  );
}
