/**
 * A ChatBackend usable before its adapter module has loaded.
 *
 * Each adapter is a separate chunk (the demo world and the signal-cli client
 * are both large, and a session only ever needs one), so `createSnowdrop`
 * imports it dynamically. Services are wired synchronously, though, and some
 * read *which optional methods exist* up front (`SendService.capabilities`,
 * the UI's `resolveAttachmentUrl` check). So each backend registration
 * (`app/backends.ts`) declares its capabilities, and a test keeps them in
 * line with the real adapters.
 *
 * Async methods await the adapter; `on()` subscriptions made early are
 * attached once it arrives; `getStatus()` is "connecting" until then.
 *
 * Every `ChatBackend` member is listed once in `FORWARDING`, which is typed
 * to cover the whole interface: adding a member without saying how it is
 * forwarded is a compile error. Arguments always pass through unchanged.
 */
import type { BackendEvents, BackendKind, ChatBackend, LinkFlow } from '@/core/backend';
import type { Unsubscribe } from '@/core/lib';

type Keys = keyof ChatBackend;
type RequiredKeys = {
  [K in Keys]-?: object extends Pick<ChatBackend, K> ? never : K;
}[Keys];
/** The `supports*()` capability flags: known only once the adapter has connected. */
export type CapabilityFlag = Extract<Keys, `supports${string}`>;
/** Every optional, non-flag member: present only when the registration declares it. */
export type OptionalMethod = Exclude<Keys, RequiredKeys | CapabilityFlag>;

/**
 * How each member is forwarded:
 * - `required`: always present; awaits the adapter, then calls it with the same arguments;
 * - `async`: the same, but only present when the registration declares it, and a
 *   method the adapter lacks rejects with `missing(...)`;
 * - `flag`: `false` until the adapter is known, then whatever it answers (a flag
 *   the adapter lacks stays `false`);
 * - `queued`: synchronous and fire-and-forget; calls made before the adapter loads
 *   are replayed, in order, when it does;
 * - `peek`: synchronous lookup, `undefined` until the adapter is known;
 * - `link`: the device-linking object (two async methods);
 * - `custom`: written out by hand below (`kind`, `getStatus`, `on`).
 */
type FlagKind = 'flag';
type OptionalKind = 'async' | 'queued' | 'peek' | 'link';
type Forwarding = {
  [K in Keys]: K extends CapabilityFlag
    ? FlagKind
    : K extends RequiredKeys
      ? 'required' | 'custom'
      : OptionalKind;
};

export const FORWARDING: Forwarding = {
  kind: 'custom',
  getStatus: 'custom',
  on: 'custom',
  connect: 'required',
  disconnect: 'required',
  getSelf: 'required',
  listContacts: 'required',
  listConversations: 'required',
  send: 'required',
  edit: 'required',
  react: 'required',
  deleteForEveryone: 'required',
  setTyping: 'required',
  markRead: 'required',
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
  readPhonePrivacy: 'async',
  updatePhonePrivacy: 'async',
  updateProfile: 'async',
  acknowledge: 'queued',
  link: 'link',
  syncContactsAndGroups: 'async',
  lookupRecipient: 'async',
  supportsReadSync: 'flag',
  supportsCustomEmojiDelivery: 'flag',
  supportsPhonePrivacy: 'flag',
  supportsCatchingUpSignal: 'flag',
  supportsOrderedCatchingUp: 'flag',
  supportsStickerPackInstall: 'flag',
  supportsAttachmentBackfill: 'flag',
};

const keysOf = (kinds: readonly string[]): Keys[] =>
  (Object.keys(FORWARDING) as Keys[]).filter((k) => kinds.includes(FORWARDING[k]));

/** Every optional method a registration may declare (`BackendRegistration.capabilities`). */
export const OPTIONAL_METHODS = keysOf(['async', 'queued', 'peek', 'link']) as OptionalMethod[];

interface Subscription {
  event: keyof BackendEvents;
  fn: (payload: never) => void;
  off: Unsubscribe | null;
  active: boolean;
}

function missing(name: string): never {
  throw new TypeError(`Backend has no ${name}()`);
}

/**
 * @param kind the registration's kind (reported before the adapter loads)
 * @param caps the registration's declared optional methods
 * @param ready resolves with the real adapter once its chunk has loaded
 */
export function deferredBackend(
  kind: BackendKind,
  caps: ReadonlySet<OptionalMethod>,
  ready: Promise<ChatBackend>,
): ChatBackend {
  let real: ChatBackend | null = null;
  const subscriptions = new Set<Subscription>();
  // Fire-and-forget calls made before the adapter loads (acknowledge, and the
  // retain/release pairs) are replayed in order once it does: an id retained
  // then released while still "connecting" must not end up retained forever
  // (or vice versa).
  const replay: Array<(backend: ChatBackend) => void> = [];
  // Avoid an unhandled rejection before a call observes it; calls reject with the error.
  ready.then(
    (backend) => {
      real = backend;
      for (const sub of subscriptions) {
        if (sub.active)
          sub.off = backend.on(
            sub.event,
            sub.fn as (payload: BackendEvents[typeof sub.event]) => void,
          );
      }
      for (const apply of replay.splice(0)) apply(backend);
    },
    () => undefined,
  );
  const call = <T>(fn: (backend: ChatBackend) => Promise<T>): Promise<T> => ready.then(fn);

  // Members are assigned by name from the table, so this is the one untyped spot.
  const target: Record<string, unknown> = {};
  const declared = (key: Keys) =>
    caps.has(key as OptionalMethod) || !OPTIONAL_METHODS.includes(key as OptionalMethod);

  for (const key of keysOf(['required', 'async'])) {
    if (!declared(key)) continue;
    target[key] = (...args: unknown[]) =>
      call((b) => {
        const method = (b as unknown as Record<string, unknown>)[key];
        return typeof method === 'function'
          ? (Reflect.apply(method, b, args) as Promise<unknown>)
          : missing(key);
      });
  }
  for (const key of keysOf(['flag'])) {
    target[key] = (...args: unknown[]) => {
      const method = real ? (real as unknown as Record<string, unknown>)[key] : undefined;
      return typeof method === 'function' ? (Reflect.apply(method, real, args) as boolean) : false;
    };
  }

  const named = (backend: ChatBackend, key: Keys) =>
    (backend as unknown as Record<string, unknown>)[key];
  for (const key of keysOf(['queued'])) {
    if (!declared(key)) continue;
    target[key] = (...args: unknown[]) => {
      const apply = (b: ChatBackend) => {
        const method = named(b, key);
        if (typeof method === 'function') Reflect.apply(method, b, args);
      };
      if (real) apply(real);
      else replay.push(apply);
    };
  }
  // Synchronous lookups: nothing is known before the real backend exists.
  for (const key of keysOf(['peek'])) {
    if (!declared(key)) continue;
    target[key] = (...args: unknown[]) => {
      const method = real ? named(real, key) : undefined;
      return typeof method === 'function'
        ? (Reflect.apply(method, real, args) as unknown)
        : undefined;
    };
  }

  const backend = target as unknown as ChatBackend;
  Object.assign(target, {
    kind,
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
  } satisfies Pick<ChatBackend, 'kind' | 'getStatus' | 'on'>);

  if (caps.has('link'))
    backend.link = {
      start: (...args: Parameters<LinkFlow['start']>) =>
        call((b) => (b.link ? b.link.start(...args) : missing('link.start'))),
      finish: (...args: Parameters<LinkFlow['finish']>) =>
        call((b) => (b.link ? b.link.finish(...args) : missing('link.finish'))),
    };
  return backend;
}
