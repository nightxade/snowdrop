/**
 * Cancellation helpers shared by the backend adapters and the app shell.
 * An abort is always an `AppError` of kind `aborted`, so callers tell "the
 * caller gave up" from a real failure with one check ({@link isAborted}) and
 * never show it to the user.
 */
import { AppError, ignored, type ErrorOutcome } from './errors';

export function abortedError(
  message = 'Request aborted',
  outcome: ErrorOutcome = 'unknown',
): AppError {
  return new AppError('aborted', message, { outcome });
}

/** Whether `error` is a caller-requested abort rather than a failure. */
export function isAborted(error: unknown): boolean {
  return error instanceof AppError && error.kind === 'aborted';
}

/** Rejects with an `aborted` error when `signal` has already fired (nothing was started). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError('Request aborted', 'not-sent');
}

/**
 * Settles with `promise`, or rejects with an `aborted` error as soon as
 * `signal` fires. The work behind `promise` is not cancelled: use it for work
 * other callers share (a cached download) or that cannot be stopped; the
 * caller just stops waiting.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  outcome: ErrorOutcome = 'unknown',
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The abandoned work may still reject; that must not become an unhandled rejection.
    promise.catch(ignored('the caller already gave up on this work'));
    return Promise.reject(abortedError('Request aborted', 'not-sent'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortedError('Request aborted', outcome));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * One signal that fires when any of `signals` does (`AbortSignal.any` is not
 * available in every webview this app runs in). Call `dispose` when the work
 * is done so the source signals drop their listeners.
 */
export function anySignal(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  const fired = live.find((s) => s.aborted);
  if (fired) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  const onAbort = (): void => {
    controller.abort();
  };
  for (const s of live) s.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const s of live) s.removeEventListener('abort', onAbort);
    },
  };
}
