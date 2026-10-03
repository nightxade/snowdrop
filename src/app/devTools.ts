/**
 * Development-only helpers (never installed in production builds):
 * - `window.__snowdrop` — the running instance, for poking at state.
 * - `__snowdrop.stress(n)` / `?stress=5000` — backfills n synthetic messages
 *   into the open (or first group) conversation, to profile scrolling.
 * - `__snowdrop.failNext()` — the demo backend rejects its next command, to
 *   see failure states (e.g. a failed send with Retry).
 */
import { MockBackend } from '@/core/backend/mock';
import {
  mergeDuplicate,
  messageId,
  parseMarkdownToRanges,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import type { Snowdrop } from './createSnowdrop';

const LINES = [
  'Pushed the fix, can someone **review**?',
  'lunch?',
  'That graph looks _way_ better now',
  'I think the `retry` loop is the culprit here',
  "Can't make it today, sorry ||I'm at the crag||",
  'Agreed 👍',
  'Here is the long version: we tried three approaches and the second one was the only one that survived the load test without dropping frames on the older laptops.',
  '```\nnpm run build\n```',
  'ok',
  '~~Friday~~ Saturday then',
];

async function stress(snowdrop: Snowdrop, count: number): Promise<ConversationId | null> {
  const { stores, repository, history } = snowdrop;
  const ui = stores.ui.getState();
  const conversations = Object.values(stores.conversations.getState().byId);
  const target =
    conversations.find((c) => c.id === uiSelectors.selectedConversation(ui)) ??
    conversations.find((c) => c.kind === 'group');
  if (!target) return null;
  const oldest = (await repository.page(target.id, { after: -Infinity, limit: 1 }))[0];
  const start = (oldest?.sentAt ?? Date.now()) - count * 45_000;
  const authors = target.memberIds.length > 0 ? target.memberIds : [target.id];
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    const authorId = authors[(i * 7 + (i >> 3)) % authors.length] ?? authors[0] ?? 'stress';
    const sentAt = start + i * 45_000;
    const { body, ranges } = parseMarkdownToRanges(`${LINES[i % LINES.length] ?? ''} (#${i + 1})`);
    messages.push({
      id: messageId(authorId, sentAt),
      conversationId: target.id,
      authorId,
      sentAt,
      receivedAt: sentAt,
      body,
      ranges,
      attachments: [],
      reactions:
        i % 11 === 0 ? [{ emoji: '🎯', authorId: authors[0] ?? authorId, at: sentAt + 1000 }] : [],
      status: 'read',
      kind: 'normal',
    });
  }
  await repository.upsertMany(messages, { backfill: true, merge: mergeDuplicate });
  await history.jumpToPresent(target.id);
  return target.id;
}

export function installDevTools(snowdrop: Snowdrop): void {
  const tools = {
    snowdrop,
    stress: (count = 5000) => stress(snowdrop, count),
    failNext: () => {
      void snowdrop.backendReady.then((backend) => {
        if (backend instanceof MockBackend) backend.failNext();
      });
    },
  };
  Object.assign(window, { __snowdrop: tools });
  const count = Number(new URLSearchParams(window.location.search).get('stress'));
  if (count > 0) {
    const unsubscribe = snowdrop.stores.session.subscribe((s) => {
      if (!s.ready) return;
      unsubscribe();
      void stress(snowdrop, count).then((id) => {
        if (id) snowdrop.stores.ui.getState().selectConversation(id);
      });
    });
  }
}
