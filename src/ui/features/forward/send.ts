/**
 * Sending forwarded messages: one ordinary send per message per chat, through
 * the same outbox and optimistic path as typing, so each one shows up in its
 * chat with its own pending / failed state and a Retry.
 */
import type { OutgoingAttachment, OutgoingLinkPreview } from '@/core/backend';
import type { ConversationId, StickerContent } from '@/core/domain';
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
export type ForwardItem =
  | { kind: 'sticker'; sticker: StickerContent }
  | { kind: 'message'; text: string; files: ForwardFile[]; preview?: ForwardLinkPreview };

export type TargetResult =
  { id: ConversationId; ok: true } | { id: ConversationId; ok: false; reason: string };

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

const fail = (id: ConversationId, reason: string): TargetResult => ({ id, ok: false, reason });

/**
 * Sends `items`, in order, to one chat. A contact with no chat yet gets one
 * (nothing is opened); a message request is accepted first, which is what
 * writing to it does. Never rejects: a send that can't start says why.
 */
export async function forwardToTarget(
  app: AppServices,
  target: ForwardTarget,
  items: readonly ForwardItem[],
): Promise<TargetResult> {
  try {
    let id = target.id;
    if (!target.view && !app.stores.conversations.getState().byId[id]) {
      if (!target.contact) return fail(id, "This chat isn't available.");
      id = ensureDirectConversation(app, target.contact);
    }
    if (selectMessageRequestState(app.stores, id) === 'request' && !(await app.requests.accept(id)))
      return fail(id, "Couldn't accept the message request.");
    for (const item of items) {
      // Sent messages only appear in a window anchored to the present.
      const window = app.stores.messages.getState().windows[id];
      if (window && !window.anchoredToPresent) await app.history.jumpToPresent(id);
      if (item.kind === 'sticker') {
        await app.send.sendSticker({ conversationId: id, sticker: item.sticker });
        continue;
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
      if (nonce === null) return fail(id, 'There was nothing to send.');
    }
    return { id, ok: true };
  } catch {
    // Never what was in the message: only that it failed.
    log.warn('forwarding to a chat failed');
    return fail(target.id, "Couldn't send.");
  }
}

/** Sends to every target at once; each chat keeps the messages' order. */
export function forwardToTargets(
  app: AppServices,
  targets: readonly ForwardTarget[],
  items: readonly ForwardItem[],
): Promise<TargetResult[]> {
  return Promise.all(targets.map((target) => forwardToTarget(app, target, items)));
}
