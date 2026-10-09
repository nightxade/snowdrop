/**
 * Desktop notifications (PLAN §3.3) for new incoming messages.
 *
 * Rules, in order (see `decideNotification`):
 * 1. Notifications on, mode not "none", permission granted.
 * 2. Only other people's normal (non-system, non-deleted) messages.
 * 3. Never for the conversation you're looking at: window focused, page
 *    visible, conversation open and scrolled to the newest message.
 * 4. A muted conversation or space stays silent unless the message mentions
 *    you or a plugin boosts it (Keyword Alerts).
 * 5. "Mentions only": groups notify only on mentions/boosts; direct messages
 *    still notify (they're addressed to you).
 *
 * The browser API is injected so the rules are testable headless.
 */
import {
  mentionsContact,
  MENTION_PLACEHOLDER,
  rangesToSegments,
  type ConversationId,
  type Message,
  type Segment,
} from '@/core/domain';
import type { Clock, Unsubscribe } from '@/core/lib';
import {
  DEFAULT_LOCAL_CONVERSATION,
  HOME,
  isMuted,
  UNKNOWN_CONTACT_NAME,
  type Stores,
} from '@/core/stores';

export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export interface ShownNotification {
  close(): void;
}

export interface NotificationApi {
  permission(): NotificationPermissionState;
  request(): Promise<NotificationPermissionState>;
  /** Shows a notification; returns null when the platform refused. */
  show(
    content: { title: string; body: string; tag: string },
    onClick: () => void,
  ): ShownNotification | null;
}

export interface NotificationDecision {
  title: string;
  body: string;
  conversationId: ConversationId;
  /** Why it got through a mute/mentions-only filter, if it did. */
  reason: 'mention' | 'boost' | 'normal';
}

export interface NotificationServiceDeps {
  stores: Stores;
  api: NotificationApi;
  clock: Clock;
  /** New stored messages with initial-sync provenance (SyncService). */
  source: {
    on(
      event: 'messageArrived',
      fn: (event: { message: Message; live: boolean }) => void,
    ): Unsubscribe;
  };
  /** Plugin boosters (Registries.boostReason). */
  boost?: (message: Message) => string | null;
  /** Page visibility; defaults to "visible". */
  isVisible?: () => boolean;
  /** Brings the app window to the front (window.focus). */
  focusWindow?: () => void;
  /** After a click opened a conversation (the app focuses its composer). */
  onOpened?: (id: ConversationId) => void;
}

/** Modals a notification click may close: none of them hold unsaved input. */
const DISMISSIBLE_MODALS = new Set(['switcher', 'shortcuts', 'settings']);

const MAX_BODY = 140;

function spaceOf(stores: Stores, id: ConversationId): string | null {
  for (const space of Object.values(stores.spaces.getState().spaces))
    if (space.categories.some((c) => c.conversationIds.includes(id))) return space.id;
  return null;
}

/** Plain-text preview that never reveals spoilers. */
export function notificationText(
  message: Pick<Message, 'body' | 'ranges' | 'attachments'>,
  nameFor: (id: string) => string,
): string {
  const walk = (segments: readonly Segment[]): string =>
    segments
      .map((s) => {
        if (s.type === 'text') return s.text.replaceAll(MENTION_PLACEHOLDER, '');
        if (s.type === 'mention') return `@${nameFor(s.mentionId)}`;
        if (s.style === 'spoiler') return '▒▒▒▒';
        return walk(s.children);
      })
      .join('');
  const text = walk(rangesToSegments(message.body, message.ranges)).replace(/\s+/gu, ' ').trim();
  if (!text) {
    const n = message.attachments.length;
    return n > 0 ? `Sent ${n === 1 ? 'an attachment' : `${n} attachments`}` : 'New message';
  }
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}

/** Pure decision for one message given the current state (exported for tests). */
export function decideNotification(
  stores: Stores,
  message: Message,
  options: { now: number; visible: boolean; boost?: string | null },
): NotificationDecision | null {
  const settings = stores.settings.getState().notifications;
  if (!settings.enabled || settings.mode === 'none') return null;
  const selfId = stores.session.getState().self?.id ?? null;
  if (message.kind !== 'normal' || message.deleted || message.authorId === selfId) return null;

  const id = message.conversationId;
  const ui = stores.ui.getState();
  const viewing =
    ui.windowFocused &&
    options.visible &&
    ui.selectedConversationBySpace[ui.selectedSpace] === id &&
    ui.scrolledUp[id] !== true;
  if (viewing) return null;

  const conversation = stores.conversations.getState().byId[id];
  const local = stores.local.getState().conversations[id] ?? DEFAULT_LOCAL_CONVERSATION;
  const spaceId = spaceOf(stores, id);
  const spaceMuted = spaceId ? (stores.spaces.getState().spaces[spaceId]?.muted ?? false) : false;
  const muted = spaceMuted || isMuted(local.muted, options.now);
  const mentioned = selfId !== null && mentionsContact(message, selfId);
  const boosted = Boolean(options.boost);
  const important = mentioned || boosted;
  const isGroup = conversation?.kind === 'group';

  if (muted && !important) return null;
  if (settings.mode === 'mentions' && isGroup && !important) return null;

  const contacts = stores.contacts.getState().byId;
  const self = stores.session.getState().self;
  const nameFor = (cid: string) =>
    contacts[cid]?.name ?? (cid === self?.id ? self.name : UNKNOWN_CONTACT_NAME);
  const author = nameFor(message.authorId);
  const title = conversation?.kind === 'group' ? conversation.title : author;
  let body = settings.showPreview ? notificationText(message, nameFor) : 'New message';
  if (isGroup && settings.showPreview) body = `${author}: ${body}`;
  if (options.boost && !mentioned) body = `${options.boost} · ${body}`;
  return {
    title,
    body,
    conversationId: id,
    reason: mentioned ? 'mention' : boosted ? 'boost' : 'normal',
  };
}

export class NotificationService {
  private unsub: Unsubscribe | null = null;
  private startedAt = Infinity;
  private readonly shown = new Map<ConversationId, ShownNotification>();

  constructor(private readonly deps: NotificationServiceDeps) {}

  start(): void {
    if (this.unsub) return;
    this.startedAt = this.deps.clock.now();
    this.unsub = this.deps.source.on('messageArrived', ({ message, live }) => {
      // The daemon can finish draining old envelopes after initial sync ends.
      // Keep those messages in history, without announcing them as new.
      if (live && message.sentAt >= this.startedAt) this.handle(message);
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    for (const n of this.shown.values()) n.close();
    this.shown.clear();
  }

  permission(): NotificationPermissionState {
    return this.deps.api.permission();
  }

  requestPermission(): Promise<NotificationPermissionState> {
    return this.deps.api.request();
  }

  /** A sample notification (Settings → Notifications → Send a test). */
  test(): boolean {
    if (this.permission() !== 'granted') return false;
    return (
      this.deps.api.show(
        {
          title: 'Snowdrop',
          body: 'Notifications are working. This is how new messages will appear.',
          tag: 'snowdrop-test',
        },
        () => this.deps.focusWindow?.(),
      ) !== null
    );
  }

  /** Returns the decision taken (for tests and debugging). */
  handle(message: Message): NotificationDecision | null {
    if (this.deps.api.permission() !== 'granted') return null;
    const decision = decideNotification(this.deps.stores, message, {
      now: this.deps.clock.now(),
      visible: this.deps.isVisible?.() ?? true,
      boost: this.deps.boost?.(message) ?? null,
    });
    if (!decision) return null;
    const id = decision.conversationId;
    // One notification per conversation: a newer message replaces the older one.
    this.shown.get(id)?.close();
    const shown = this.deps.api.show(
      { title: decision.title, body: decision.body, tag: `snowdrop:${id}` },
      () => {
        this.open(id);
      },
    );
    if (shown) this.shown.set(id, shown);
    else this.shown.delete(id);
    return decision;
  }

  /** Click → focus the window and open the conversation where it lives. */
  open(id: ConversationId): void {
    const { stores } = this.deps;
    this.deps.focusWindow?.();
    const kind = stores.conversations.getState().byId[id]?.kind;
    const space = kind === 'group' ? (spaceOf(stores, id) ?? HOME) : HOME;
    const modal = stores.ui.getState().modal;
    if (modal && DISMISSIBLE_MODALS.has(modal.type)) stores.ui.getState().closeModal();
    stores.ui.getState().selectConversation(id, space);
    this.shown.get(id)?.close();
    this.shown.delete(id);
    this.deps.onOpened?.(id);
  }
}

/** The Notification API of the browser, or an inert stand-in where there is none. */
export function browserNotificationApi(): NotificationApi {
  const N = typeof Notification === 'undefined' ? null : Notification;
  return {
    permission: () => (N ? N.permission : 'unsupported'),
    request: async () => (N ? await N.requestPermission() : 'unsupported'),
    show: ({ title, body, tag }, onClick) => {
      if (N?.permission !== 'granted') return null;
      try {
        const n = new N(title, { body, tag, icon: '/snowdrop.svg', silent: true });
        n.onclick = () => {
          onClick();
          n.close();
        };
        return {
          close: () => {
            n.close();
          },
        };
      } catch {
        // Some platforms (Android Chrome) only allow notifications from a service worker.
        return null;
      }
    },
  };
}
