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
  POLL_EMOJI,
  pollEndedText,
  pollPreviewText,
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
  selectMessageRequestState,
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

/** Someone else's vote on a poll of ours, or the end of someone's poll (see SyncEvents.pollActivity). */
export interface PollActivityEvent {
  kind: 'vote' | 'end';
  message: Message;
  actorId: string;
  live: boolean;
}

export interface NotificationServiceDeps {
  stores: Stores;
  api: NotificationApi;
  clock: Clock;
  /** New stored messages, and news about polls, with initial-sync provenance (SyncService). */
  source: {
    on(
      event: 'messageArrived',
      fn: (event: { message: Message; live: boolean }) => void,
    ): Unsubscribe;
    on(event: 'pollActivity', fn: (event: PollActivityEvent) => void): Unsubscribe;
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
  message: Pick<Message, 'body' | 'ranges' | 'attachments' | 'sticker' | 'poll'>,
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
    if (message.poll) return `${POLL_EMOJI} ${pollPreviewText(message.poll)}`;
    if (message.sticker)
      return message.sticker.emoji ? `${message.sticker.emoji} Sticker` : 'Sticker';
    const n = message.attachments.length;
    return n > 0 ? `Sent ${n === 1 ? 'an attachment' : `${n} attachments`}` : 'New message';
  }
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}

/** What a notification may be judged on, besides the text: who, where and how important. */
interface Gate {
  conversationId: ConversationId;
  important: boolean;
}

/**
 * The rules that don't depend on what is being announced: the settings, not
 * announcing what the user is looking at, mute, and "mentions only".
 */
function passesGate(
  stores: Stores,
  gate: Gate,
  options: { now: number; visible: boolean },
): boolean {
  const settings = stores.settings.getState().notifications;
  if (!settings.enabled || settings.mode === 'none') return false;
  const id = gate.conversationId;
  const ui = stores.ui.getState();
  const viewing =
    ui.windowFocused &&
    options.visible &&
    ui.selectedConversationBySpace[ui.selectedSpace] === id &&
    ui.scrolledUp[id] !== true;
  if (viewing) return false;

  const conversation = stores.conversations.getState().byId[id];
  const local = stores.local.getState().conversations[id] ?? DEFAULT_LOCAL_CONVERSATION;
  const spaceId = spaceOf(stores, id);
  const spaceMuted = spaceId ? (stores.spaces.getState().spaces[spaceId]?.muted ?? false) : false;
  const muted = spaceMuted || isMuted(local.muted, options.now);
  if (muted && !gate.important) return false;
  if (settings.mode === 'mentions' && conversation?.kind === 'group' && !gate.important)
    return false;
  return true;
}

function nameResolver(stores: Stores): (id: string) => string {
  const contacts = stores.contacts.getState().byId;
  const self = stores.session.getState().self;
  return (cid) => contacts[cid]?.name ?? (cid === self?.id ? self.name : UNKNOWN_CONTACT_NAME);
}

/** The title a notification carries: the group, or the person in a direct chat. */
function notificationTitle(stores: Stores, id: ConversationId, author: string): string {
  const conversation = stores.conversations.getState().byId[id];
  const request = selectMessageRequestState(stores, id) !== 'accepted';
  return conversation?.kind === 'group'
    ? request
      ? `${author} in ${conversation.title}`
      : conversation.title
    : author;
}

/** Pure decision for one message given the current state (exported for tests). */
export function decideNotification(
  stores: Stores,
  message: Message,
  options: { now: number; visible: boolean; boost?: string | null },
): NotificationDecision | null {
  const settings = stores.settings.getState().notifications;
  const selfId = stores.session.getState().self?.id ?? null;
  if (message.kind !== 'normal' || message.deleted || message.authorId === selfId) return null;

  const id = message.conversationId;
  const mentioned = selfId !== null && mentionsContact(message, selfId);
  const boosted = Boolean(options.boost);
  if (!passesGate(stores, { conversationId: id, important: mentioned || boosted }, options))
    return null;

  const isGroup = stores.conversations.getState().byId[id]?.kind === 'group';
  const nameFor = nameResolver(stores);
  const author = nameFor(message.authorId);
  // An unaccepted message request, as Signal Desktop shows it: the sender
  // (and group) in the title, and "Message Request" instead of the text, so
  // a stranger's words never reach the desktop before the user has decided.
  const request = selectMessageRequestState(stores, id) !== 'accepted';
  const title = notificationTitle(stores, id, author);
  let body = settings.showPreview
    ? request
      ? 'Message Request'
      : notificationText(message, nameFor)
    : 'New message';
  if (isGroup && settings.showPreview && !request) body = `${author}: ${body}`;
  if (options.boost && !mentioned) body = `${options.boost} · ${body}`;
  return {
    title,
    body,
    conversationId: id,
    reason: mentioned ? 'mention' : boosted ? 'boost' : 'normal',
  };
}

/**
 * Signal Desktop's notifications for polls: someone else's vote on a poll the
 * user created (`Mira voted in the poll "Where to eat?"`), and someone ending
 * their poll (`Mira ended the poll: Where to eat?`). The same rules as a
 * message apply, minus mentions and boosts; with previews off it is only
 * "New message", never the question.
 */
export function decidePollNotification(
  stores: Stores,
  event: PollActivityEvent,
  options: { now: number; visible: boolean },
): NotificationDecision | null {
  const settings = stores.settings.getState().notifications;
  const selfId = stores.session.getState().self?.id ?? null;
  const { message } = event;
  if (!message.poll || message.deleted || event.actorId === selfId) return null;
  const id = message.conversationId;
  if (!passesGate(stores, { conversationId: id, important: false }, options)) return null;
  const actor = nameResolver(stores)(event.actorId);
  const request = selectMessageRequestState(stores, id) !== 'accepted';
  const question = message.poll.question;
  const text =
    event.kind === 'vote'
      ? `${actor} voted in the poll "${question}"`
      : `${POLL_EMOJI} ${pollEndedText(actor, question)}`;
  return {
    title: notificationTitle(stores, id, actor),
    body: settings.showPreview ? (request ? 'Message Request' : text) : 'New message',
    conversationId: id,
    reason: 'normal',
  };
}

export class NotificationService {
  private unsub: Unsubscribe | null = null;
  private unsubPolls: Unsubscribe | null = null;
  private startedAt = Infinity;
  private readonly shown = new Map<ConversationId, ShownNotification>();

  constructor(private readonly deps: NotificationServiceDeps) {}

  start(): void {
    if (this.unsub) return;
    this.startedAt = this.deps.clock.now();
    this.unsub = this.deps.source.on('messageArrived', ({ message, live }) => {
      // The daemon can finish draining old envelopes after initial sync ends,
      // and signal-cli's catch-up drain (SyncService's CatchUpTracker; see
      // stores.session.notificationsHeld) can still be running after that, and
      // starts again on every reconnect while Snowdrop keeps running (after a
      // sleep, `startedAt` is hours old): all of these are old messages
      // replayed, not new ones to announce.
      const held = this.deps.stores.session.getState().notificationsHeld;
      if (live && message.sentAt >= this.startedAt && !held) this.handle(message);
    });
    this.unsubPolls = this.deps.source.on('pollActivity', (event) => {
      // Replayed (parked, or drained after a reconnect) news is old news, as for messages.
      const held = this.deps.stores.session.getState().notificationsHeld;
      if (event.live && !held) this.handlePoll(event);
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.unsubPolls?.();
    this.unsubPolls = null;
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
    return decision ? this.show(decision) : null;
  }

  private show(decision: NotificationDecision): NotificationDecision {
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

  /** Returns the decision taken, like `handle`. */
  handlePoll(event: PollActivityEvent): NotificationDecision | null {
    if (this.deps.api.permission() !== 'granted') return null;
    const decision = decidePollNotification(this.deps.stores, event, {
      now: this.deps.clock.now(),
      visible: this.deps.isVisible?.() ?? true,
    });
    return decision ? this.show(decision) : null;
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
