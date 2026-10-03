/**
 * Settings → Data & Storage: a JSON dump of everything stored locally, so
 * people can keep their history (signal-cli itself keeps none).
 */
import type { Attachment, ConversationId, Message } from '@/core/domain';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';

/** Attachments are listed, never embedded (no bytes, no URLs). */
export type ExportedAttachment = Pick<Attachment, 'contentType'> &
  Partial<Pick<Attachment, 'fileName' | 'size'>>;

export type ExportedMessage = Omit<Message, 'attachments'> & { attachments: ExportedAttachment[] };

export interface HistoryExport {
  format: 'snowdrop-history';
  version: 1;
  exportedAt: string;
  account: { id: string; name: string } | null;
  conversations: {
    id: ConversationId;
    kind: 'direct' | 'group';
    title: string;
    messages: ExportedMessage[];
  }[];
  contacts: { id: string; name: string; number?: string }[];
}

const PAGE = 500;

/**
 * Disappearing messages are left out: the sender chose for them not to last,
 * and a backup file would outlive the timer.
 */
export function toExportedMessage(message: Message): ExportedMessage | null {
  if (message.expiresAt !== undefined) return null;
  return {
    ...message,
    attachments: message.attachments.map((a) => ({
      contentType: a.contentType,
      ...(a.fileName !== undefined ? { fileName: a.fileName } : {}),
      ...(a.size !== undefined ? { size: a.size } : {}),
    })),
  };
}

/** Pages each conversation's stored history from oldest to newest. */
export async function exportHistory(
  repository: Pick<MessageRepository, 'page'>,
  stores: Stores,
  now: Date = new Date(),
  onProgress?: (done: number, total: number) => void,
): Promise<HistoryExport> {
  const conversations = Object.values(stores.conversations.getState().byId);
  const out: HistoryExport['conversations'] = [];
  let done = 0;
  for (const c of conversations) {
    const messages: ExportedMessage[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await repository.page(c.id, {
        limit: PAGE,
        ...(before === undefined ? {} : { before }),
      });
      if (page.length === 0) break;
      messages.unshift(
        ...page.map(toExportedMessage).filter((m): m is ExportedMessage => m !== null),
      );
      const first = page[0]?.seq;
      if (page.length < PAGE || first === undefined) break;
      before = first;
    }
    out.push({ id: c.id, kind: c.kind, title: c.title, messages });
    onProgress?.(++done, conversations.length);
  }
  const self = stores.session.getState().self;
  return {
    format: 'snowdrop-history',
    version: 1,
    exportedAt: now.toISOString(),
    account: self ? { id: self.id, name: self.name } : null,
    conversations: out,
    contacts: Object.values(stores.contacts.getState().byId).map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.number ? { number: c.number } : {}),
    })),
  };
}
