/**
 * A ChatBackend usable before its adapter module has loaded.
 *
 * Each adapter is a separate chunk (the demo world and the signal-cli client
 * are both large, and a session only ever needs one), so `createSnowdrop`
 * imports it dynamically. Services are wired synchronously, though, and some
 * read *what the backend supports* up front (`SendService.capabilities`, the
 * menus). So each backend registration (`app/backends.ts`) declares the
 * `features` the adapter has before it connects, and a test keeps them in line
 * with the real adapters' static `FEATURES`. The store starts with those, then
 * mirrors the adapter's own once it has loaded.
 *
 * Every `ChatBackend` method exists on every adapter (one that can't do
 * something rejects with `UnsupportedError`), so the wrapper always has all of
 * them. Async methods await the adapter; `on()` subscriptions made early are
 * attached once it arrives; `getStatus()` is "connecting" until then.
 *
 * Every `ChatBackend` member is listed once in `FORWARDING`, which is typed
 * to cover the whole interface: adding a member without saying how it is
 * forwarded is a compile error. Arguments always pass through unchanged.
 */
import { anySignal, ignored } from '@/core/lib';
import type {
  AbortOptions,
  BackendEvents,
  BackendKind,
  ChatBackend,
  Feature,
  LinkFlow,
} from '@/core/backend';
import type { Unsubscribe } from '@/core/lib';
import { FeatureStore } from '@/core/backend/features';

type Keys = keyof ChatBackend;

/**
 * How each member is forwarded:
 * - `async`: awaits the adapter, then calls it with the same arguments;
 * - `queued`: synchronous and fire-and-forget; calls made before the adapter loads
 *   are replayed, in order, when it does;
 * - `peek`: synchronous lookup, answering `PEEK_BEFORE_LOAD` until the adapter is known;
 * - `link`: the device-linking object (two async methods);
 * - `custom`: written out by hand below (`kind`, `getStatus`, `on`, `capabilities`).
 */
type Forwarding = 'async' | 'queued' | 'peek' | 'link' | 'custom';

export const FORWARDING: Record<Keys, Forwarding> = {
  kind: 'custom',
  getStatus: 'custom',
  on: 'custom',
  capabilities: 'custom',
  connect: 'async',
  disconnect: 'async',
  getSelf: 'async',
  listContacts: 'async',
  listConversations: 'async',
  send: 'async',
  edit: 'async',
  react: 'async',
  deleteForEveryone: 'async',
  setTyping: 'async',
  markRead: 'async',
  fetchHistory: 'async',
  remapHistoryMessages: 'async',
  historyHasOutgoing: 'async',
  getHistoryArchiveId: 'async',
  readHistory: 'async',
  getHistoryReadState: 'async',
  adminDelete: 'async',
  pinMessage: 'async',
  votePoll: 'async',
  terminatePoll: 'async',
  updateConversation: 'async',
  updateGroup: 'async',
  createGroup: 'async',
  leaveGroup: 'async',
  respondToMessageRequest: 'async',
  setBlocked: 'async',
  getSafetyNumber: 'async',
  verifyIdentity: 'async',
  approveIdentity: 'async',
  resolveAttachmentUrl: 'async',
  readAttachmentBlob: 'async',
  retainAttachmentUrl: 'queued',
  releaseAttachmentUrl: 'queued',
  resolveAvatarUrl: 'async',
  peekAvatarUrl: 'peek',
  hasPendingEvents: 'peek',
  resolveStickerUrl: 'async',
  retainStickerUrl: 'queued',
  releaseStickerUrl: 'queued',
  listStickerPacks: 'async',
  getStickerPack: 'async',
  installStickerPack: 'async',
  requestAttachmentBackfill: 'async',
  syncDeleteForMe: 'async',
  readPhonePrivacy: 'async',
  updatePhonePrivacy: 'async',
  updateProfile: 'async',
  acknowledge: 'queued',
  link: 'link',
  syncContactsAndGroups: 'async',
  lookupRecipient: 'async',
};

/**
 * Where the trailing `{ signal }` options sit in the calls that take one.
 * With a shutdown signal, these calls also stop when it fires.
 */
const SIGNAL_OPTIONS_AT = {
  send: 1,
  fetchHistory: 2,
  resolveAttachmentUrl: 2,
  readAttachmentBlob: 2,
} as const satisfies Partial<Record<Keys, number>>;

/** `args` with the options at `index` carrying a signal that also fires on `shutdown`. */
function withShutdown(
  args: unknown[],
  index: number,
  shutdown: AbortSignal,
): { args: unknown[]; dispose: () => void } {
  const options = (args[index] ?? {}) as AbortOptions;
  const { signal, dispose } = anySignal([options.signal, shutdown]);
  const next = [...args];
  while (next.length < index) next.push(undefined);
  next[index] = { ...options, signal };
  return { args: next, dispose };
}

/** Runs `run` with the shutdown signal merged into the call's options, if there is one. */
function guarded<T>(
  shutdown: AbortSignal | undefined,
  args: unknown[],
  index: number,
  run: (args: unknown[]) => Promise<T>,
): Promise<T> {
  if (!shutdown) return run(args);
  const merged = withShutdown(args, index, shutdown);
  return run(merged.args).finally(merged.dispose);
}

type PeekKey = 'peekAvatarUrl' | 'hasPendingEvents';

/**
 * What a `peek` member answers before the adapter has loaded. Every `peek`
 * entry in `FORWARDING` must have one (a test checks).
 */
export const PEEK_BEFORE_LOAD: { [K in PeekKey]: ReturnType<ChatBackend[K]> } = {
  peekAvatarUrl: undefined,
  hasPendingEvents: false,
};

const keysOf = (kind: Forwarding): Keys[] =>
  (Object.keys(FORWARDING) as Keys[]).filter((k) => FORWARDING[k] === kind);

interface Subscription {
  event: keyof BackendEvents;
  fn: (payload: never) => void;
  off: Unsubscribe | null;
  active: boolean;
}

/**
 * @param kind the registration's kind (reported before the adapter loads)
 * @param features the registration's declared features (what the adapter has before it connects)
 * @param ready resolves with the real adapter once its chunk has loaded
 * @param shutdown fires when the session is closing: the long calls (`send`,
 *   `link.*`, `fetchHistory`, `resolveAttachmentUrl`, `readAttachmentBlob`) stop
 *   waiting for the daemon (an abort of a send says `maybe-sent`), in
 *   addition to any signal the caller passes
 */
export function deferredBackend(
  kind: BackendKind,
  features: Iterable<Feature>,
  ready: Promise<ChatBackend>,
  shutdown?: AbortSignal,
): ChatBackend {
  let real: ChatBackend | null = null;
  // The registration's set until the adapter arrives, then its set, and every change after.
  const capabilities = new FeatureStore(features);
  const subscriptions = new Set<Subscription>();
  // Fire-and-forget calls made before the adapter loads (acknowledge, and the
  // retain/release pairs) are replayed in order once it does: an id retained
  // then released while still "connecting" must not end up retained forever
  // (or vice versa).
  const replay: Array<(backend: ChatBackend) => void> = [];
  // Avoid an unhandled rejection before a call observes it; calls reject with the error.
  ready.then((backend) => {
    real = backend;
    capabilities.set(backend.capabilities.features);
    // The adapter lives as long as this wrapper, so the mirror is never detached.
    backend.capabilities.subscribe(() => {
      capabilities.set(backend.capabilities.features);
    });
    for (const sub of subscriptions) {
      if (sub.active)
        sub.off = backend.on(
          sub.event,
          sub.fn as (payload: BackendEvents[typeof sub.event]) => void,
        );
    }
    for (const apply of replay.splice(0)) apply(backend);
  }, ignored('a failed backend start is reported by the connect itself; calls on the deferred backend reject on their own'));
  const call = <T>(fn: (backend: ChatBackend) => Promise<T>): Promise<T> => ready.then(fn);

  // Members are assigned by name from the table, so this is the one untyped spot.
  const target: Record<string, unknown> = {};
  const invoke = (b: ChatBackend, key: Keys, args: unknown[]): unknown => {
    const method = (b as unknown as Record<string, unknown>)[key];
    return Reflect.apply(method as (...a: unknown[]) => unknown, b, args);
  };
  for (const key of keysOf('async')) {
    const signalAt = (SIGNAL_OPTIONS_AT as Partial<Record<Keys, number>>)[key];
    target[key] =
      signalAt === undefined
        ? (...args: unknown[]) => call((b) => invoke(b, key, args) as Promise<unknown>)
        : (...args: unknown[]) =>
            guarded(shutdown, args, signalAt, (merged) =>
              call((b) => invoke(b, key, merged) as Promise<unknown>),
            );
  }
  for (const key of keysOf('queued')) {
    target[key] = (...args: unknown[]) => {
      const apply = (b: ChatBackend) => {
        invoke(b, key, args);
      };
      if (real) apply(real);
      else replay.push(apply);
    };
  }
  // Synchronous lookups: nothing is known before the real backend exists.
  for (const key of keysOf('peek')) {
    target[key] = (...args: unknown[]) =>
      real ? invoke(real, key, args) : PEEK_BEFORE_LOAD[key as PeekKey];
  }

  const backend = target as unknown as ChatBackend;
  Object.assign(target, {
    kind,
    capabilities,
    // Loading the adapter is the first step of connecting.
    getStatus: () => real?.getStatus() ?? 'connecting',
    on(event, fn) {
      const sub: Subscription = { event, fn, off: null, active: true };
      subscriptions.add(sub);
      if (real) sub.off = real.on(event, fn);
      return () => {
        sub.active = false;
        sub.off?.();
        subscriptions.delete(sub);
      };
    },
  } satisfies Pick<ChatBackend, 'kind' | 'capabilities' | 'getStatus' | 'on'>);

  backend.link = {
    start: (...args: Parameters<LinkFlow['start']>) =>
      guarded(shutdown, args, 0, (merged) =>
        call((b) => b.link.start(...(merged as Parameters<LinkFlow['start']>))),
      ),
    finish: (...args: Parameters<LinkFlow['finish']>) =>
      guarded(shutdown, args, 2, (merged) =>
        call((b) => b.link.finish(...(merged as Parameters<LinkFlow['finish']>))),
      ),
  };
  return backend;
}
