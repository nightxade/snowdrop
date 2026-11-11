import { describeFailure } from '@/ui/lib/connectionErrors';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { LinkFlow } from '@/core/backend';
import { isAborted } from '@/core/lib';
import {
  defaultDeviceName,
  initialLinkState,
  isExpiry,
  linkReducer,
  type LinkState,
} from './linkFlow';

/** Drives `link.start/finish` through the link state machine. */
export function useLinkFlow(
  link: LinkFlow | undefined,
  onLinked: (accountId: string) => void,
  desktop = false,
) {
  const [state, dispatch] = useReducer(linkReducer, undefined, () =>
    initialLinkState(
      defaultDeviceName(typeof navigator === 'undefined' ? '' : navigator.userAgent, desktop),
    ),
  );
  const linked = useRef(onLinked);
  useEffect(() => {
    linked.current = onLinked;
  }, [onLinked]);

  const pending = useRef(0);
  // The in-flight attempt's `start`/`finish` calls. Aborted when the screen is
  // left, the user goes back to edit, or a new attempt replaces it, so the
  // daemon stops waiting for a phone that will never scan.
  const inFlight = useRef<AbortController | null>(null);
  const abortInFlight = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);
  // Set while unmounted: a late result of an abandoned attempt (the user went
  // back, or the screen was replaced) must not call `onLinked`. Reset on
  // mount so StrictMode's cleanup-and-rerun doesn't leave it set.
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      abortInFlight();
    };
  }, [abortInFlight]);
  useEffect(() => {
    if (state.step !== 'starting' || !link) return;
    const { attempt, deviceName } = state;
    // StrictMode re-runs effects: one daemon link session per attempt.
    if (pending.current === attempt) return;
    pending.current = attempt;
    abortInFlight();
    const controller = new AbortController();
    inFlight.current = controller;
    const { signal } = controller;
    let uri: string | null = null;
    link
      .start({ signal })
      .then((started) => {
        uri = started.uri;
        dispatch({ type: 'started', uri: started.uri, attempt });
        return link.finish(started.uri, deviceName, { signal });
      })
      .then(({ accountId, historyWarning }) => {
        dispatch({
          type: 'linked',
          accountId,
          attempt,
          ...(historyWarning ? { historyWarning } : {}),
        });
        if (!disposed.current && pending.current === attempt && !historyWarning) {
          linked.current(accountId);
        }
      })
      .catch((error: unknown) => {
        // Abandoned on purpose (left, edited, restarted): not a failure.
        if (signal.aborted || isAborted(error)) return;
        dispatch({
          type: 'failed',
          attempt,
          expired: uri !== null && isExpiry(error),
          message: describeFailure(error),
        });
      });
  }, [state, link, abortInFlight]);

  const start = useCallback(() => {
    dispatch({ type: 'start' });
  }, []);
  const rename = useCallback((deviceName: string) => {
    dispatch({ type: 'rename', deviceName });
  }, []);
  const edit = useCallback(() => {
    pending.current = 0;
    abortInFlight();
    dispatch({ type: 'edit' });
  }, [abortInFlight]);

  const continueLinked = useCallback(() => {
    if (state.step === 'linked') linked.current(state.accountId);
  }, [state]);

  return {
    state: state satisfies LinkState,
    start,
    rename,
    edit,
    continueLinked,
    supported: link !== undefined,
  };
}
