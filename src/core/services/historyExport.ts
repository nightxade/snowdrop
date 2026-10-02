/**
 * Settings → Data & Storage: a JSON dump of everything stored locally, so
 * people can keep their history (signal-cli itself keeps none).
 */
import type { ConversationId, Message } from '@/core/domain';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';

export interface HistoryExport {
  format: 'shrike-history';
  version: 1;
  exportedAt: string;
  account: { id: string; name: string } | null;
  conversations: {
    id: ConversationId;
    kind: 'direct' | 'group';
    title: string;
    messages: Message[];
  }[];
  contacts: { id: string; name: string; number?: string }[];
}

const PAGE = 500;

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
    const messages: Message[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await repository.page(c.id, {
        limit: PAGE,
        ...(before === undefined ? {} : { before }),
      });
      if (page.length === 0) break;
      messages.unshift(...page);
      const first = page[0]?.seq;
      if (page.length < PAGE || first === undefined) break;
      before = first;
    }
    out.push({ id: c.id, kind: c.kind, title: c.title, messages });
    onProgress?.(++done, conversations.length);
  }
  const self = stores.session.getState().self;
  return {
    format: 'shrike-history',
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
