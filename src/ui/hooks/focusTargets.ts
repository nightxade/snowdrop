import type { ConversationId } from '@/core/domain';
import { describeFocus } from './textSurfaces';

/**
 * Where keyboard focus should land after navigating to a conversation (quick
 * switcher, profile "Message", …). Two things register a preferred target:
 * the composer (explicit "type here" intent — a reply, or the "Focus the
 * message box" setting) and the message list (its roving tab stop, the
 * default landing spot everywhere else). Until either exists this is the
 * conversation's sidebar row.
 */
export type ConversationFocusResolver = (id: ConversationId) => HTMLElement | null | undefined;

let composerResolver: ConversationFocusResolver | null = null;
let listResolver: ConversationFocusResolver | null = null;

/**
 * A plugin that wants every conversation-opening path to land focus
 * predictably — the composer reachable only through its own explicit keys,
 * never the "Focus the message box when opening a conversation" setting,
 * never wherever a click or a space switch happened to leave focus —
 * registers a policy here (Vim mode does, while its navigation keys are
 * on). While none is registered, every function below keeps today's
 * behaviour exactly.
 */
let focusPolicyActive: (() => boolean) | null = null;

/** Registers a conversation-focus policy. Returns an unregister function. */
export function setConversationFocusPolicy(isActive: () => boolean): () => void {
  focusPolicyActive = isActive;
  return () => {
    if (focusPolicyActive === isActive) focusPolicyActive = null;
  };
}

/** Whether a plugin's conversation-focus policy is currently active. */
export function conversationFocusPolicyActive(): boolean {
  return focusPolicyActive?.() ?? false;
}

/** Registers the composer as a focus target. Returns an unregister function. */
export function setConversationFocusResolver(fn: ConversationFocusResolver): () => void {
  composerResolver = fn;
  return () => {
    if (composerResolver === fn) composerResolver = null;
  };
}

/** Registers the message list's roving tab stop as a focus target. Returns an unregister function. */
export function setConversationListFocusResolver(fn: ConversationFocusResolver): () => void {
  listResolver = fn;
  return () => {
    if (listResolver === fn) listResolver = null;
  };
}

const sidebarRow = (id: ConversationId): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[data-snowdrop="sidebar"] [data-conversation-id="${CSS.escape(id)}"][data-roving-item]`,
  );

/**
 * The focus target for a conversation. By default this is the message list's
 * current row (the newest message); with `preferComposer` (the "Focus the
 * message box when opening a conversation" setting, or an explicit reply) it
 * is the composer instead. Either falls back to the other, then to the
 * conversation's sidebar row, so focus always lands somewhere real.
 */
export function conversationFocusTarget(
  id: ConversationId,
  preferComposer = false,
): HTMLElement | null {
  // A plugin's focus policy (Vim mode) always wins over "prefer the composer":
  // the setting that asks for it is ignored while that policy is active.
  const effective = preferComposer && !conversationFocusPolicyActive();
  const first = effective ? composerResolver?.(id) : listResolver?.(id);
  if (first) return first;
  const second = effective ? listResolver?.(id) : composerResolver?.(id);
  if (second) return second;
  return sidebarRow(id);
}

/**
 * How many animation frames a path that opens a conversation keeps looking
 * for its target: the new view's list registers a frame or two after the
 * view mounts. (A list that remounts later, as its messages load, hands focus
 * on itself: see MessageList.)
 */
const FOCUS_SETTLE_FRAMES = 30;

/** How many animation frames `followConversationOpenFocus` waits for the list before the fallback chain. */
const FOCUS_RETRY_FRAMES = 5;

const inSidebar = (el: Element): boolean => el.closest('[data-snowdrop="sidebar"]') !== null;

function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

interface SettleOptions {
  /** Focus on the first frame whatever has it (an explicit command; the old view still holds focus). */
  force?: boolean;
  /** Keep looking after landing on a sidebar row, to move to the message list once it exists. */
  upgradeFromSidebar?: boolean;
  /** How many frames the element that had focus when the command ran still counts as free (it is still the trigger). */
  startFreeFrames?: number;
}

/**
 * The one retry loop behind every path that opens a conversation. Each
 * animation frame, for a bounded number of frames, it moves focus to
 * `resolve()`, but only while nothing else has it: focus is on `<body>`, or
 * (for the first frame, `startFreeFrames` at most) still on the element that
 * had it when the command ran. Focus anywhere else, an input or a dialog
 * included, ends it, so it never steals focus.
 */
function settleFocus(
  resolve: () => HTMLElement | null | undefined,
  { force = false, upgradeFromSidebar = false, startFreeFrames = 1 }: SettleOptions = {},
): void {
  const start = focusedElement();
  let ours: HTMLElement | null = null;
  let frame = 0;
  const tick = (): void => {
    frame += 1;
    const active = focusedElement();
    // Landed earlier: only here to move on from a sidebar row, never from anywhere else.
    if (ours !== null && (active !== ours || !ours.isConnected)) return;
    const forced = force && frame === 1;
    const free = ours !== null || active === null || (active === start && frame <= startFreeFrames);
    if (!forced && (!free || blocked())) return;
    const next = resolve();
    if (next && next !== active) next.focus();
    if (next && document.activeElement === next) {
      ours = next;
      if (!(upgradeFromSidebar && inSidebar(next))) return;
    }
    if (frame < FOCUS_SETTLE_FRAMES) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const blocked = (): boolean => {
  const focus = describeFocus(document, false);
  return focus.overlay || focus.target === 'input';
};

/** Focuses the target once the navigation has rendered. */
export function focusConversation(id: ConversationId, preferComposer = false): void {
  settleFocus(() => conversationFocusTarget(id, preferComposer), {
    force: true,
    upgradeFromSidebar: true,
  });
}

/**
 * Call just before a command switches conversation (Alt+↑/↓, next unread,
 * Vim J/K/]u). Returns the function to call with the new conversation: it
 * moves focus deliberately instead of letting it fall to `<body>` when the
 * old view unmounts.
 *
 * From a sidebar row, focus follows to the new row (so you can keep
 * stepping). From anywhere else, it lands on `conversationFocusTarget` —
 * the message list's current row by default, or the composer when
 * `preferComposer` (the "Focus the message box when opening a conversation"
 * setting) is on. The new view's list may not exist on the first frame, so a
 * sidebar row it lands on is swapped for the list when it appears.
 */
export function followConversationFocus(preferComposer = false): (id: ConversationId) => void {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const fromRow =
    before?.matches('[data-roving-item][data-conversation-id]') === true && inSidebar(before);
  return (id) => {
    settleFocus(
      () => (fromRow ? sidebarRow(id) : null) ?? conversationFocusTarget(id, preferComposer),
      { force: true, upgradeFromSidebar: !fromRow },
    );
  };
}

/**
 * For a trigger that doesn't manage focus itself — a sidebar click, a space
 * switch — and only while a focus policy is active (see
 * `setConversationFocusPolicy`): lands on the new conversation's message
 * list, never the composer and never wherever the trigger left focus (the
 * row just clicked, the previous list), so keyboard navigation works right
 * away. A no-op when no policy is registered, so today's behaviour is
 * untouched outside it, and it never steals focus from another input, a
 * menu or a dialog.
 *
 * Keyboard stepping between conversations from a sidebar row (Vim's J/K)
 * goes through `followConversationFocus` instead, which deliberately keeps
 * focus on the row so stepping continues — this is never called for that.
 */
export function followConversationOpenFocus(id: ConversationId): void {
  if (!conversationFocusPolicyActive()) return;
  let attempt = 0;
  settleFocus(
    () => {
      attempt += 1;
      // The message list for the new conversation may not have mounted any
      // rows yet (this runs on a rAF, Virtuoso's rows render on a later one):
      // give it a few more frames rather than settling immediately for
      // `conversationFocusTarget`'s composer/sidebar-row fallback.
      const fromList = listResolver?.(id);
      if (fromList) return fromList;
      return attempt < FOCUS_RETRY_FRAMES ? null : conversationFocusTarget(id, false);
    },
    { upgradeFromSidebar: true, startFreeFrames: FOCUS_RETRY_FRAMES },
  );
}

/**
 * Call just before a command switches space (Next / Previous space), then call the returned
 * function once the space is selected. Focus that was in the sidebar (a row, New message, a
 * heading) goes to the new space's list tab stop, and focus that was on the rail goes to the new
 * space's tile, so stepping goes on from there. Focus elsewhere stays, unless it would fall to
 * the page, when it lands on the list's tab stop. A plugin's focus policy has its own landing
 * (`followConversationOpenFocus`), which wins.
 */
export function followSpaceFocus(): () => void {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const fromRail = before?.closest('[data-snowdrop="rail"]') != null;
  const fromSidebar = before?.closest('[data-snowdrop="sidebar"]') != null;
  const listStop = () =>
    document.querySelector<HTMLElement>(
      '[data-snowdrop="sidebar"] [data-roving-item][tabindex="0"]',
    );
  const railTile = () =>
    document.querySelector<HTMLElement>(
      '[data-snowdrop="rail"] [data-roving-item][aria-current="page"]',
    );
  return () => {
    if (conversationFocusPolicyActive()) return;
    const moves = fromRail || fromSidebar;
    settleFocus(() => (fromRail ? (railTile() ?? listStop()) : listStop()), {
      force: moves,
      startFreeFrames: moves ? FOCUS_RETRY_FRAMES : 0,
    });
  };
}
