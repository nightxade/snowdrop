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
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
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
  /** Each body reads `<text> <n>`. */
  text?: string;
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
  state(): { selected: string | null; online: boolean; catchingUp: boolean };
}

let lastSentAt = 0;
/** Strictly increasing, so no two messages ever share an identity. */
function nextSentAt(): number {
  lastSentAt = Math.max(Date.now(), lastSentAt + 1);
  return lastSentAt;
}

function create(snowdrop: Snowdrop, backend: MockBackend): JourneyDriver {
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
  return {
    conversationId: (key) => conv(key),
    deliver: async ({ conversation, count = 1, spacingMs = 0, from, text = 'Journey message' }) => {
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
          body: `${text} ${i + 1}`,
          ranges: [],
          attachments: [],
          reactions: [],
          status: 'read',
          kind: 'normal',
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
    typing: (conversation, typing, from) => {
      const id = conv(conversation);
      backend.emit('typing', { conversationId: id, authorId: sender(id, from), typing });
    },
    state: () => ({
      selected: uiSelectors.selectedConversation(snowdrop.stores.ui.getState()) ?? null,
      online: backend.getStatus() === 'online',
      catchingUp: snowdrop.stores.session.getState().catchingUp,
    }),
  };
}

/** Installs `window.__journey` once the demo backend is up. */
export function installJourneyDriver(snowdrop: Snowdrop): void {
  void snowdrop.backendReady.then(() => {
    if (!prepared) return;
    Object.assign(window, { __journey: create(snowdrop, prepared) });
  });
}
