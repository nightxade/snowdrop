import { useCallback, useSyncExternalStore } from 'react';

/**
 * One shared ticker per interval: every component asking for "now, refreshed
 * each minute" reads the same clock, so a list of 200 rows costs one timer,
 * not 200, and they all update in the same render.
 */
interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const tickers = new Map<number, Ticker>();

function tickerFor(intervalMs: number): Ticker {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    ticker = { now: Date.now(), listeners: new Set(), timer: null };
    tickers.set(intervalMs, ticker);
  }
  return ticker;
}

function subscribe(intervalMs: number, listener: () => void): () => void {
  const ticker = tickerFor(intervalMs);
  ticker.listeners.add(listener);
  if (ticker.timer === null) {
    // Don't touch `now` here: changing the snapshot during subscribe would
    // force a re-render of every reader.
    ticker.timer = setInterval(() => {
      ticker.now = Date.now();
      for (const fn of [...ticker.listeners]) fn();
    }, intervalMs);
  }
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0 && ticker.timer !== null) {
      clearInterval(ticker.timer);
      ticker.timer = null;
    }
  };
}

/**
 * While nobody is subscribed the timer is off, so the first reader after a
 * pause refreshes a stale value (once; later reads in the same interval agree).
 */
function snapshot(intervalMs: number): number {
  const ticker = tickerFor(intervalMs);
  if (ticker.timer === null && Date.now() - ticker.now >= intervalMs) ticker.now = Date.now();
  return ticker.now;
}

/** Current time, refreshed every `intervalMs` (for mute expiry and similar). */
export function useNow(intervalMs = 60_000): number {
  const sub = useCallback((fn: () => void) => subscribe(intervalMs, fn), [intervalMs]);
  return useSyncExternalStore(
    sub,
    () => snapshot(intervalMs),
    () => snapshot(intervalMs),
  );
}
