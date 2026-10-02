import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { LinkFlow } from '@/core/backend';
import {
  defaultDeviceName,
  initialLinkState,
  isExpiry,
  linkReducer,
  type LinkState,
} from './linkFlow';

/** Drives `link.start/finish` through the link state machine. */
export function useLinkFlow(link: LinkFlow | undefined, onLinked: (accountId: string) => void) {
  const [state, dispatch] = useReducer(linkReducer, undefined, () =>
    initialLinkState(
      defaultDeviceName(typeof navigator === 'undefined' ? '' : navigator.userAgent),
    ),
  );
  const linked = useRef(onLinked);
  useEffect(() => {
    linked.current = onLinked;
  }, [onLinked]);

  const pending = useRef(0);
  useEffect(() => {
    if (state.step !== 'starting' || !link) return;
    const { attempt, deviceName } = state;
    // StrictMode re-runs effects: one daemon link session per attempt.
    if (pending.current === attempt) return;
    pending.current = attempt;
    let uri: string | null = null;
    link
      .start()
      .then((started) => {
        uri = started.uri;
        dispatch({ type: 'started', uri: started.uri, attempt });
        return link.finish(started.uri, deviceName);
      })
      .then(({ accountId }) => {
        dispatch({ type: 'linked', accountId, attempt });
        if (pending.current === attempt) linked.current(accountId);
      })
      .catch((error: unknown) => {
        dispatch({
          type: 'failed',
          attempt,
          expired: uri !== null && isExpiry(error),
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [state, link]);

  const start = useCallback(() => {
    dispatch({ type: 'start' });
  }, []);
  const rename = useCallback((deviceName: string) => {
    dispatch({ type: 'rename', deviceName });
  }, []);
  const edit = useCallback(() => {
    pending.current = 0;
    dispatch({ type: 'edit' });
  }, []);

  return { state: state satisfies LinkState, start, rename, edit, supported: link !== undefined };
}
