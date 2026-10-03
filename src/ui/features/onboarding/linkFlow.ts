/**
 * Device-linking state machine (PLAN §4.10), pure so every transition is
 * tested. The driver (useLinkFlow) calls `link.start()` for a code, then
 * `link.finish(uri, name)`, which resolves once the phone has scanned it.
 */

export type LinkState =
  /** `attempt` survives going back to naming, so late results of an abandoned attempt are ignored. */
  | { step: 'naming'; deviceName: string; attempt: number }
  | { step: 'starting'; deviceName: string; attempt: number }
  | { step: 'waiting'; deviceName: string; uri: string; attempt: number }
  | { step: 'linked'; deviceName: string; accountId: string }
  | { step: 'failed'; deviceName: string; message: string; expired: boolean; attempt: number };

export type LinkAction =
  | { type: 'rename'; deviceName: string }
  | { type: 'start' }
  | { type: 'started'; uri: string; attempt: number }
  | { type: 'linked'; accountId: string; attempt: number }
  | { type: 'failed'; message: string; expired?: boolean; attempt: number }
  | { type: 'edit' };

export const MAX_DEVICE_NAME = 50;

export function initialLinkState(deviceName: string): LinkState {
  return { step: 'naming', deviceName: deviceName.slice(0, MAX_DEVICE_NAME), attempt: 0 };
}

function attemptOf(state: LinkState): number {
  return state.step === 'linked' ? 0 : state.attempt;
}

export function linkReducer(state: LinkState, action: LinkAction): LinkState {
  switch (action.type) {
    case 'rename':
      return state.step === 'naming' || state.step === 'failed'
        ? { ...state, deviceName: action.deviceName.slice(0, MAX_DEVICE_NAME) }
        : state;
    case 'start': {
      if (state.step === 'starting' || state.step === 'waiting' || state.step === 'linked')
        return state;
      const deviceName = state.deviceName.trim();
      if (!deviceName) return state;
      return { step: 'starting', deviceName, attempt: attemptOf(state) + 1 };
    }
    case 'started':
      // Results of an abandoned attempt (retry/edit since) are ignored.
      return state.step === 'starting' && state.attempt === action.attempt
        ? {
            step: 'waiting',
            deviceName: state.deviceName,
            uri: action.uri,
            attempt: action.attempt,
          }
        : state;
    case 'linked':
      return state.step === 'waiting' && state.attempt === action.attempt
        ? { step: 'linked', deviceName: state.deviceName, accountId: action.accountId }
        : state;
    case 'failed':
      return (state.step === 'starting' || state.step === 'waiting') &&
        state.attempt === action.attempt
        ? {
            step: 'failed',
            deviceName: state.deviceName,
            message: action.message,
            expired: action.expired ?? false,
            attempt: action.attempt,
          }
        : state;
    case 'edit':
      // Back to the name field; any pending attempt is abandoned.
      return state.step === 'linked'
        ? state
        : { step: 'naming', deviceName: state.deviceName, attempt: attemptOf(state) };
  }
}

/** A default device name people will recognise in Signal → Linked devices. */
export function defaultDeviceName(userAgent: string): string {
  const browser = /Firefox\//u.test(userAgent)
    ? 'Firefox'
    : /Edg\//u.test(userAgent)
      ? 'Edge'
      : /Chrome\//u.test(userAgent)
        ? 'Chrome'
        : /Safari\//u.test(userAgent)
          ? 'Safari'
          : null;
  const os = /Mac OS X|Macintosh/u.test(userAgent)
    ? 'Mac'
    : /Windows/u.test(userAgent)
      ? 'Windows'
      : /Android/u.test(userAgent)
        ? 'Android'
        : /Linux/u.test(userAgent)
          ? 'Linux'
          : null;
  const where = [browser, os].filter(Boolean).join(' on ');
  return where ? `Snowdrop (${where})` : 'Snowdrop';
}

/** Is this failure the code timing out (worth a fresh code) rather than a hard error? */
export function isExpiry(error: unknown): boolean {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? error.kind : null;
  const message = error instanceof Error ? error.message : '';
  return kind === 'timeout' || /expired|timed? ?out/iu.test(message);
}
