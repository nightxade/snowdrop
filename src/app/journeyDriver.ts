/**
 * The journey build's test driver (`vite build --mode journey`; never in the
 * normal production build, where `import.meta.env.MODE` is not "journey" and
 * every call site below is dead code).
 *
 * It gives a scripted user journey (journeys/) control over the demo backend
 * from outside the page: live arrivals, a catch-up replayed in bursts the way
 * the patched signal-cli does it, receipts, typing. It reuses the backend's
 * own hooks (`deliver`, `emit`) and adds no behaviour of its own.
 *
 * `?journeyCatchUp=held` makes the demo act like a patched signal-cli
 * (`catchingUpSignal`, `orderedCatchingUp`): the connection's own catch-up
 * stays open until the journey calls `caughtUp()`.
 */
import type { MockBackend } from '@/core/backend/mock';
import { MOCK_EMOJI_PNG } from '@/core/backend/mock/content/customEmoji';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { attentionOf, isMuted, selectConversationView, uiSelectors } from '@/core/stores';
import { previewText } from '@/ui/features/conversation';
import type { Snowdrop } from './createSnowdrop';

/** Set before the backend connects, read when the driver is installed. */
const held = { enabled: false, released: false, seq: 0 };
let prepared: MockBackend | null = null;

/** Called by the mock registration once the backend exists, before it connects. */
export function prepareJourneyBackend(backend: MockBackend): void {
  prepared = backend;
  held.enabled = new URLSearchParams(window.location.search).get('journeyCatchUp') === 'held';
  if (!held.enabled) return;
  backend.capabilities.setFeature('catchingUpSignal', true);
  backend.capabilities.setFeature('orderedCatchingUp', true);
  // The demo says "caught up" the moment it connects; a patched signal-cli
  // says it only after the backlog. Hold that one signal back.
  const realEmit = backend.emit.bind(backend);
  backend.emit = (event, payload) => {
    if (event === 'caughtUp' && !held.released) return;
    realEmit(event, payload);
  };
}

export interface DeliverOptions {
  /** A conversation key of the demo world (`crux`, `dm-ines`, ...). */
  conversation: string;
  count?: number;
  /** Pause between messages, ms. */
  spacingMs?: number;
  /** A person key (`ines`); defaults to the conversation's first other member. */
  from?: string;
  /** Each body reads `<text> <n>`, or exactly `<text>` with `exact`. */
  text?: string;
  /** The body is `text` as given (a message of one emoji, say). */
  exact?: boolean;
  /** The message delivers a `:partyblob:` custom emoji and the body is `text` (with the token). */
  customEmoji?: boolean;
}

export interface JourneyDriver {
  /** The conversation id for a world key. */
  conversationId(key: string): string;
  /** Live arrivals; resolves after the last one. */
  deliver(options: DeliverOptions): Promise<number>;
  /** The backend starts draining a queue again (`catchingUp`). */
  startCatchUp(): void;
  /** The backend says its queue is drained (`caughtUp`). */
  caughtUp(): void;
  /** Receipts for every message the user sent in the conversation. */
  receipt(conversation: string, type: 'delivered' | 'read'): number;
  typing(conversation: string, typing: boolean, from?: string): void;
  /** Any backend event, as if it came from the network (an edit, a delete, a reaction, a group change). */
  emit(event: string, payload: unknown): void;
  /** Every history load from now on takes this many ms longer (a slow real backend). */
  setLoadDelay(ms: number): void;
  /** Every send from now on takes this many ms before the backend takes it (a message stays pending). */
  setSendDelay(ms: number): void;
  state(): JourneyState;
}

/** What a conversation should show in the sidebar, worked out from the stores and the demo's history. */
export interface JourneyConversation {
  id: string;
  /** The world key (`dm-priya`), usable with `deliver`, `typing` and `receipt`. */
  key: string;
  title: string;
  /** The preview the newest message calls for (`previewText`), empty without one. */
  expectedPreview: string;
  unread: number;
  mentions: number;
  /** The unread marker the row should carry (`attentionOf`). */
  hasUnread: boolean;
  muted: boolean;
  /** A direct chat the demo refuses to send to (a changed, unapproved key), by design. */
  sendRefused: boolean;
}

export interface JourneyState {
  selected: string | null;
  online: boolean;
  catchingUp: boolean;
  /** The notification hold (`notificationsHeld`): on from a connect until the queue is empty. */
  notificationsHeld: boolean;
  /** What the app believes about its window (`document.hasFocus()` at the last focus event). */
  windowFocused: boolean;
  /** Whether the open chat's list is scrolled away from the newest message. */
  scrolledUp: boolean;
  selfId: string;
  conversations: JourneyConversation[];
}

function openScrolledUp(snowdrop: Snowdrop): boolean {
  const ui = snowdrop.stores.ui.getState();
  const open = uiSelectors.selectedConversation(ui);
  return open !== null && ui.scrolledUp[open] === true;
}

let lastSentAt = 0;
/** Strictly increasing, so no two messages ever share an identity. */
function nextSentAt(): number {
  lastSentAt = Math.max(Date.now(), lastSentAt + 1);
  return lastSentAt;
}

export function createJourneyDriver(snowdrop: Snowdrop, backend: MockBackend): JourneyDriver {
  const { world } = backend;
  const conv = (key: string): ConversationId => {
    const id = world.conversationIds.get(key);
    if (!id) throw new Error(`journey: unknown conversation "${key}"`);
    return id;
  };
  const sender = (id: ConversationId, from: string | undefined): string => {
    const personId = from === undefined ? undefined : world.personIds.get(from);
    const members = world.conversations.get(id)?.memberIds ?? [];
    const author = personId ?? members.find((m) => m !== world.self.id);
    if (!author) throw new Error('journey: nobody to send from');
    return author;
  };
  let sendDelayMs: number | null = null;
  return {
    conversationId: (key) => conv(key),
    deliver: async ({
      conversation,
      count = 1,
      spacingMs = 0,
      from,
      text = 'Journey message',
      exact = false,
      customEmoji = false,
    }) => {
      const id = conv(conversation);
      const authorId = sender(id, from);
      for (let i = 0; i < count; i++) {
        if (i > 0 && spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
        const sentAt = nextSentAt();
        const message: Message = {
          id: messageId(authorId, sentAt),
          conversationId: id,
          authorId,
          sentAt,
          receivedAt: sentAt,
          body: exact || customEmoji ? text : `${text} ${i + 1}`,
          ranges: [],
          attachments: [],
          reactions: [],
          status: 'read',
          kind: 'normal',
          ...(customEmoji
            ? {
                customEmoji: [
                  {
                    name: 'partyblob',
                    attachment: {
                      id: `${sentAt.toString(36)}-e0`,
                      contentType: 'image/png',
                      fileName: 'partyblob.png',
                      size: 300,
                      width: 48,
                      height: 48,
                      url: MOCK_EMOJI_PNG.sunny,
                    },
                  },
                ],
              }
            : {}),
        };
        backend.deliver(message);
      }
      return count;
    },
    startCatchUp: () => {
      held.seq += 1;
      backend.emit('catchingUp', { seq: held.seq });
    },
    caughtUp: () => {
      held.released = true;
      backend.emit('caughtUp', { seq: held.seq });
    },
    receipt: (conversation, type) => {
      const id = conv(conversation);
      const sentAts = (world.histories.get(id) ?? [])
        .filter((m) => m.authorId === world.self.id)
        .map((m) => m.sentAt);
      const authorId = sender(id, undefined);
      if (sentAts.length > 0) backend.emit('receipt', { authorId, sentAts, type });
      return sentAts.length;
    },
    setLoadDelay: (ms) => {
      backend.historyDelayMs = ms;
    },
    setSendDelay: (ms) => {
      if (sendDelayMs === null) {
        const send = backend.send.bind(backend);
        backend.send = async (input, options) => {
          await new Promise((r) => setTimeout(r, sendDelayMs ?? 0));
          return send(input, options);
        };
      }
      sendDelayMs = ms;
    },
    emit: (event, payload) => {
      backend.emit(event as 'status', payload as never);
    },
    typing: (conversation, typing, from) => {
      const id = conv(conversation);
      backend.emit('typing', { conversationId: id, authorId: sender(id, from), typing });
    },
    state: () => {
      const { conversations, messages, contacts, session, local } = snowdrop.stores;
      const selfId = session.getState().self?.id ?? world.self.id;
      const nameFor = (contactId: string) => contacts.getState().byId[contactId]?.name ?? 'Someone';
      const now = Date.now();
      const keys = new Map<string, string>();
      for (const [key, id] of world.conversationIds) keys.set(id, key);
      const newest = (id: ConversationId): Message | undefined => {
        const window = messages.getState().windows[id];
        if (window?.loaded && window.anchoredToPresent) {
          const lastId = window.ids[window.ids.length - 1];
          return lastId === undefined ? undefined : window.byId[lastId];
        }
        // A chat that is not open: the demo's own history, less what the user removed on this
        // device (deleted for me), which the repository no longer holds.
        return world.histories.get(id)?.findLast((m) => !snowdrop.expiry.hasPurged(m.id));
      };
      const { byId, unread: unreadById } = conversations.getState();
      const rows = Object.values(byId).flatMap(({ id }): JourneyConversation[] => {
        const view = selectConversationView(byId, local.getState().conversations, id);
        if (!view) return [];
        const unread = unreadById[id];
        const muted = isMuted(view.muted, now);
        const attention = attentionOf(unread, muted, view.markedUnread === true);
        return [
          {
            id,
            key: keys.get(id) ?? '',
            title: view.title,
            expectedPreview: previewText(newest(id), {
              selfId,
              isGroup: view.kind === 'group',
              nameFor,
            }),
            unread: unread?.count ?? 0,
            mentions: unread?.mentions ?? 0,
            hasUnread: attention.hasUnread,
            muted,
            sendRefused:
              view.kind === 'direct' && view.memberIds.some((m) => world.untrustedIds.has(m)),
          },
        ];
      });
      return {
        selected: uiSelectors.selectedConversation(snowdrop.stores.ui.getState()) ?? null,
        online: backend.getStatus() === 'online',
        catchingUp: session.getState().catchingUp,
        notificationsHeld: session.getState().notificationsHeld,
        windowFocused: snowdrop.stores.ui.getState().windowFocused,
        scrolledUp: openScrolledUp(snowdrop),
        selfId,
        conversations: rows,
      };
    },
  };
}

/** Installs `window.__journey` once the demo backend is up. */
export function installJourneyDriver(snowdrop: Snowdrop): void {
  void snowdrop.backendReady.then(() => {
    if (!prepared) return;
    Object.assign(window, { __journey: createJourneyDriver(snowdrop, prepared) });
  });
}
