/**
 * Main-thread stall detector (desktop and browser): a user on Linux/
 * Hyprland sees the whole window freeze for a couple of seconds, e.g. when
 * opening Settings or closing a popup. Rather than guess, this watches for
 * the freeze directly — a heartbeat timer firing late — and logs it with
 * just enough context (route, open modal, in-flight IPC command) to tell
 * which of those moments it was, without logging any message content.
 *
 * A timer, not a `requestAnimationFrame` loop: an always-running rAF loop
 * makes WebKitGTK composite every frame, which kept an idle window at
 * ~25% CPU. A late timer measures the same main-thread block for free.
 *
 * Installed once from the composition root (`createSnowdrop.ts`), only
 * when a real `document` is available (never in headless tests).
 */
import { createLogger } from '@/core/lib';
import type { Stores, UiState } from '@/core/stores';
import { desktopLastIpcCommand } from './platform';

/** How often the heartbeat is scheduled. */
const HEARTBEAT_MS = 250;
/** A heartbeat this much later than scheduled counts as a stall. */
const STALL_THRESHOLD_MS = 500;
/** At most one stall line every 5s, so a rough patch doesn't flood the log. */
const LOG_INTERVAL_MS = 5000;

const log = createLogger('perf');

function now(): number {
  return performance.now();
}

/** The settings page if one is open, else the selected space/conversation — never message content. */
function currentRoute(ui: UiState): string {
  if (ui.modal?.type === 'settings') {
    const page = ui.modal.props?.page;
    return `settings:${typeof page === 'string' ? page : 'general'}`;
  }
  const conversationId = ui.selectedConversationBySpace[ui.selectedSpace];
  return conversationId
    ? `space:${ui.selectedSpace}/${conversationId}`
    : `space:${ui.selectedSpace}`;
}

/** Context for one stall's log line: route, open modal type, and any IPC command started inside the gap. */
function describeStall(stores: Stores, gapStart: number, gapEnd: number): string {
  const ui = stores.ui.getState();
  const parts = [`route=${currentRoute(ui)}`];
  if (ui.modal) parts.push(`modal=${ui.modal.type}`);
  const lastIpc = desktopLastIpcCommand();
  if (lastIpc && lastIpc.startedAt >= gapStart && lastIpc.startedAt <= gapEnd) {
    parts.push(`ipc=${lastIpc.command}`);
  }
  return parts.join(' ');
}

/**
 * Starts a heartbeat timer and reports when it fires late. Paused while
 * `document.hidden` (a backgrounded window's timers are throttled, not
 * stalled), with an immediate reset on becoming visible again so a long
 * background spell is never itself reported as one huge gap. Returns a
 * disposer.
 */
export function installStallDetector(stores: Stores): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastBeatAt = now();
  let lastLoggedAt = -Infinity;
  let stopped = false;

  const onVisibilityChange = (): void => {
    if (!document.hidden) lastBeatAt = now();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  const beat = (): void => {
    if (stopped) return;
    const current = now();
    if (!document.hidden) {
      const late = current - lastBeatAt - HEARTBEAT_MS;
      if (late > STALL_THRESHOLD_MS && current - lastLoggedAt >= LOG_INTERVAL_MS) {
        lastLoggedAt = current;
        log.warn(`UI stalled ${Math.round(late)} ms`, describeStall(stores, lastBeatAt, current));
      }
    }
    lastBeatAt = current;
    timer = setTimeout(beat, HEARTBEAT_MS);
  };
  timer = setTimeout(beat, HEARTBEAT_MS);

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
