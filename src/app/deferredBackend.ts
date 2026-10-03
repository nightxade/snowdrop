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
 */
import type { BackendEvents, BackendKind, ChatBackend } from '@/core/backend';
import type { Unsubscribe } from '@/core/lib';

export const OPTIONAL_METHODS = [
  'fetchHistory',
  'adminDelete',
  'pinMessage',
  'updateConversation',
  'resolveAttachmentUrl',
  'acknowledge',
  'link',
] as const;

export type OptionalMethod = (typeof OPTIONAL_METHODS)[number];

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
  const acks: string[] = [];
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
      for (const cursor of acks.splice(0)) backend.acknowledge?.(cursor);
    },
    () => undefined,
  );
  const call = <T>(fn: (backend: ChatBackend) => Promise<T>): Promise<T> => ready.then(fn);

  const backend: ChatBackend = {
    kind,
    connect: () => call((b) => b.connect()),
    disconnect: () => call((b) => b.disconnect()),
    // Loading the adapter is the first step of connecting.
    getStatus: () => real?.getStatus() ?? 'connecting',
    getSelf: () => call((b) => b.getSelf()),
    listContacts: () => call((b) => b.listContacts()),
    listConversations: () => call((b) => b.listConversations()),
    send: (input) => call((b) => b.send(input)),
    edit: (input) => call((b) => b.edit(input)),
    react: (input) => call((b) => b.react(input)),
    deleteForEveryone: (conversationId, sentAt) =>
      call((b) => b.deleteForEveryone(conversationId, sentAt)),
    setTyping: (conversationId, typing) => call((b) => b.setTyping(conversationId, typing)),
    markRead: (conversationId, messages) => call((b) => b.markRead(conversationId, messages)),
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
  };

  if (caps.has('fetchHistory'))
    backend.fetchHistory = (c, q) =>
      call((b) => (b.fetchHistory ? b.fetchHistory(c, q) : missing('fetchHistory')));
  if (caps.has('adminDelete'))
    backend.adminDelete = (c, t) =>
      call((b) => (b.adminDelete ? b.adminDelete(c, t) : missing('adminDelete')));
  if (caps.has('pinMessage'))
    backend.pinMessage = (input) =>
      call((b) => (b.pinMessage ? b.pinMessage(input) : missing('pinMessage')));
  if (caps.has('updateConversation'))
    backend.updateConversation = (c, patch) =>
      call((b) =>
        b.updateConversation ? b.updateConversation(c, patch) : missing('updateConversation'),
      );
  if (caps.has('resolveAttachmentUrl'))
    backend.resolveAttachmentUrl = (c, a) =>
      call((b) =>
        b.resolveAttachmentUrl ? b.resolveAttachmentUrl(c, a) : missing('resolveAttachmentUrl'),
      );
  if (caps.has('acknowledge'))
    backend.acknowledge = (cursor) => {
      if (real) real.acknowledge?.(cursor);
      else acks.push(cursor);
    };
  if (caps.has('link'))
    backend.link = {
      start: () => call((b) => (b.link ? b.link.start() : missing('link.start'))),
      finish: (uri, name) =>
        call((b) => (b.link ? b.link.finish(uri, name) : missing('link.finish'))),
    };
  return backend;
}
