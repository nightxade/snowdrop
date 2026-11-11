/**
 * The observable contract every `ChatBackend` must keep, written once and run
 * against each adapter (and each adapter behind `deferredBackend`). The
 * services lean on these behaviours without any type saying so; a new adapter
 * (or a refactor of the wrapper) that breaks one fails here instead of in a
 * user's session.
 *
 * What is asserted, and which code relies on it:
 *
 * 1. Lifecycle. `SyncService.doStart` calls `connect()` and then reads
 *    `getStatus()`/`status` events (`setLink(backend.getStatus())`); Retry
 *    calls `connect()` again on the same instance, so connect, disconnect and
 *    connect must work, and a failed connect must leave `status` at `error`
 *    and be recoverable (`SyncService.doStart`/`doReconnect`).
 * 2. Status events only fire on a change and the last one equals `getStatus()`
 *    (the session store mirrors them; a repeat or a stale one shows a wrong
 *    banner).
 * 3. Features. `SendService` and the menus read `capabilities.features`
 *    before the adapter has connected, so the static `FEATURES` are present
 *    from construction, stay through connect, and are back after disconnect
 *    (version-dependent ones come and go).
 * 4. Event order. `SyncService` parks everything that arrives before the
 *    initial sync is done and treats `caughtUp` as "everything delivered
 *    before this is already delivered" (`SyncService`'s catch-up tracker and
 *    the adapter's ordering contract above `SignalCliBackend.enqueue`).
 *    Messages delivered before the drain signal are therefore emitted before
 *    `caughtUp`, and an adapter that has no server queue emits `caughtUp`
 *    itself, after `online`, never before.
 * 5. Errors. A call the adapter can't do rejects (never throws synchronously,
 *    never hangs) with an `AppError`; a transport failure keeps a specific
 *    `kind`, because `toAppError(e).kind` of `unknown`/`internal` routes the
 *    UI to the generic copy and loses the retry decision
 *    (`SyncService.failConnect`, `SendService.attempt`).
 * 6. Send. `SendService` stores `result.sentAt` as the message identity
 *    (`messageId(self, sentAt)`), so it must be a positive integer, and two
 *    sends must not share one; `attachments`/`recipientFailures`, when given,
 *    have the shapes `SendService` maps over.
 *
 * Where adapters legitimately differ the harness takes {@link ContractOptions}
 * rather than skipping the case.
 */
import { describe, expect, it } from 'vitest';
import type { BackendEvents, ChatBackend, Feature, SendInput, SendResult } from '@/core/backend';
import type { ConnectionStatus, ConversationId } from '@/core/domain';
import { AppError, toAppError, UnsupportedError, type ErrorKind } from '@/core/lib';

/** One backend under test, plus the hooks the harness needs to provoke the cases. */
export interface ContractSubject {
  backend: ChatBackend;
  /** Lets in-flight work (fetches, queues, microtasks) finish; uses injected time only. */
  settle: () => Promise<void>;
  /** Delivers an incoming text message from someone else, as the transport would. */
  deliverIncoming: (text: string) => Promise<void>;
  /**
   * Makes the transport fail from now on: connects and commands reject as
   * "unreachable". Absent where the adapter has nothing to break.
   */
  breakTransport?: () => void;
  /** Undoes `breakTransport`. */
  restoreTransport?: () => void;
  /** Tells a transport-driven adapter the server queue is drained. Absent for `caughtUp: 'on-connect'`. */
  signalDrained?: () => Promise<void>;
  /** A conversation the test can send to (default: the first one listed, direct first). */
  sendTarget?: () => Promise<ConversationId>;
  dispose?: () => Promise<void> | void;
}

export interface ContractOptions {
  /** The adapter's static `FEATURES` (what the registration declares too). */
  staticFeatures: ReadonlySet<Feature>;
  /**
   * Where `caughtUp` comes from: `on-connect` the adapter emits it itself once
   * online; `from-transport` only after the server says the queue is drained.
   */
  caughtUp: 'on-connect' | 'from-transport';
  /**
   * What `send` does while disconnected. `SendService` doesn't gate on the
   * link status (the outbox retries on failure), so only the demo, which
   * asserts `online`, rejects; signal-cli's HTTP client just attempts the call.
   */
  sendWhileOffline: 'rejects' | 'attempts';
  /** Whether a failed `connect()` can be provoked (needs `breakTransport`) and must end at `error`. */
  connectFailureStatus?: ConnectionStatus;
  /**
   * A method the adapter can't serve right now, and the kind its rejection
   * carries. The contract says `unsupported`; an adapter that gates a method
   * on a daemon version reports its own kind (see the case's comment).
   */
  unsupported?: {
    call: (backend: ChatBackend) => Promise<unknown>;
    kind: ErrorKind;
  };
}

type Factory = () => ContractSubject | Promise<ContractSubject>;

const TRANSPORT_FAILURE_KINDS: readonly ErrorKind[] = ['unreachable', 'timeout', 'http'];

function record<E extends keyof BackendEvents>(backend: ChatBackend, event: E): BackendEvents[E][] {
  const seen: BackendEvents[E][] = [];
  backend.on(event, (payload) => {
    seen.push(payload);
  });
  return seen;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

async function pickTarget(subject: ContractSubject): Promise<ConversationId> {
  if (subject.sendTarget) return subject.sendTarget();
  const all = await subject.backend.listConversations();
  const target = all.find((c) => c.kind === 'direct') ?? all[0];
  if (!target) throw new Error('the subject lists no conversation to send to');
  return target.id;
}

const text = (conversationId: ConversationId, body: string): SendInput => ({
  conversationId,
  body,
  ranges: [],
});

export function describeBackendContract(
  name: string,
  factory: Factory,
  options: ContractOptions,
): void {
  const withSubject = async (run: (s: ContractSubject) => Promise<void>): Promise<void> => {
    const subject = await factory();
    try {
      await subject.settle();
      await run(subject);
    } finally {
      await subject.backend.disconnect().catch(() => undefined);
      await subject.dispose?.();
    }
  };

  describe(`backend contract: ${name}`, () => {
    describe('lifecycle', () => {
      it('connects, disconnects and connects again on the same instance', async () => {
        await withSubject(async ({ backend, settle }) => {
          const statuses = record(backend, 'status');
          await backend.connect();
          await settle();
          expect(backend.getStatus()).toBe('online');
          await backend.disconnect();
          await settle();
          expect(backend.getStatus()).toBe('offline');
          await backend.connect();
          await settle();
          expect(backend.getStatus()).toBe('online');
          // Every event is a change, and the last one is what getStatus answers.
          statuses.forEach((s, i) => {
            if (i > 0) expect(s).not.toBe(statuses[i - 1]);
          });
          expect(statuses.at(-1)).toBe(backend.getStatus());
          expect(statuses.filter((s) => s === 'online')).toHaveLength(2);
        });
      });

      it('reports connecting before online, then offline after disconnect', async () => {
        await withSubject(async ({ backend, settle }) => {
          const statuses = record(backend, 'status');
          await backend.connect();
          await settle();
          await backend.disconnect();
          await settle();
          expect(statuses.indexOf('connecting')).toBeLessThan(statuses.indexOf('online'));
          expect(statuses.at(-1)).toBe('offline');
        });
      });

      it('answers disconnect while already offline', async () => {
        await withSubject(async ({ backend }) => {
          await expect(backend.disconnect()).resolves.toBeUndefined();
          expect(backend.getStatus()).toBe('offline');
        });
      });

      it('stops calling a handler once it unsubscribes', async () => {
        await withSubject(async ({ backend, settle }) => {
          const seen: ConnectionStatus[] = [];
          const off = backend.on('status', (s) => seen.push(s));
          off();
          await backend.connect();
          await settle();
          expect(seen).toEqual([]);
        });
      });
    });

    describe('features', () => {
      const has = (backend: ChatBackend): Feature[] =>
        [...options.staticFeatures].filter((f) => !backend.capabilities.features.has(f));

      it('has the static features from construction, through connect and after disconnect', async () => {
        await withSubject(async ({ backend, settle }) => {
          expect(has(backend)).toEqual([]);
          await backend.connect();
          await settle();
          expect(has(backend)).toEqual([]);
          await backend.disconnect();
          await settle();
          expect(has(backend)).toEqual([]);
        });
      });

      it('drops what only a connection knew about on disconnect', async () => {
        await withSubject(async ({ backend, settle }) => {
          const before = [...backend.capabilities.features].sort();
          await backend.connect();
          await settle();
          await backend.disconnect();
          await settle();
          expect([...backend.capabilities.features].sort()).toEqual(before);
        });
      });
    });

    describe('events', () => {
      it('emits an incoming message with the text it carried', async () => {
        await withSubject(async ({ backend, settle, deliverIncoming }) => {
          await backend.connect();
          await settle();
          const messages = record(backend, 'message');
          await deliverIncoming('hello from the transport');
          await settle();
          expect(messages.map((m) => m.body)).toContain('hello from the transport');
          const message = messages.find((m) => m.body === 'hello from the transport');
          expect(Number.isInteger(message?.sentAt)).toBe(true);
          expect(message?.conversationId).toBeTruthy();
        });
      });

      if (options.caughtUp === 'on-connect') {
        it('emits caughtUp itself, once, after the backend is online', async () => {
          await withSubject(async ({ backend, settle }) => {
            const order: string[] = [];
            backend.on('status', (s) => order.push(`status:${s}`));
            backend.on('caughtUp', () => order.push('caughtUp'));
            await backend.connect();
            await settle();
            expect(order.filter((o) => o === 'caughtUp')).toHaveLength(1);
            expect(order.indexOf('caughtUp')).toBeGreaterThan(order.indexOf('status:online'));
          });
        });
      } else {
        it('emits messages delivered before the drain signal ahead of caughtUp', async () => {
          await withSubject(async ({ backend, settle, deliverIncoming, signalDrained }) => {
            await backend.connect();
            await settle();
            const order: string[] = [];
            backend.on('message', (m) => order.push(`message:${m.body}`));
            backend.on('caughtUp', () => order.push('caughtUp'));
            await deliverIncoming('queued one');
            await deliverIncoming('queued two');
            await signalDrained?.();
            await settle();
            expect(order).toEqual(['message:queued one', 'message:queued two', 'caughtUp']);
          });
        });

        it('does not emit caughtUp on its own', async () => {
          await withSubject(async ({ backend, settle }) => {
            const caughtUp = record(backend, 'caughtUp');
            await backend.connect();
            await settle();
            expect(caughtUp).toEqual([]);
          });
        });
      }

      it('numbers a catch-up mark with a seq when it carries one', async () => {
        await withSubject(async ({ backend, settle, signalDrained }) => {
          const marks = record(backend, 'caughtUp');
          await backend.connect();
          await settle();
          await signalDrained?.();
          await settle();
          for (const mark of marks) {
            if (mark !== undefined) expect(Number.isInteger(mark.seq)).toBe(true);
          }
        });
      });
    });

    describe('send', () => {
      it('resolves with a result SendService can store', async () => {
        await withSubject(async (subject) => {
          await subject.backend.connect();
          await subject.settle();
          const target = await pickTarget(subject);
          const result: SendResult = await subject.backend.send(text(target, 'hi'));
          expect(Number.isInteger(result.sentAt)).toBe(true);
          expect(result.sentAt).toBeGreaterThan(0);
          if (result.attachments !== undefined)
            expect(Array.isArray(result.attachments)).toBe(true);
          for (const failure of result.recipientFailures ?? [])
            expect(typeof failure.recipientId).toBe('string');
        });
      });

      it('gives two sends different identities', async () => {
        await withSubject(async (subject) => {
          await subject.backend.connect();
          await subject.settle();
          const target = await pickTarget(subject);
          const a = await subject.backend.send(text(target, 'one'));
          const b = await subject.backend.send(text(target, 'two'));
          expect(b.sentAt).not.toBe(a.sentAt);
        });
      });

      it(
        options.sendWhileOffline === 'rejects'
          ? 'rejects with an AppError when not connected'
          : 'is not gated on the connection status: it either settles with a result or an AppError',
        async () => {
          await withSubject(async (subject) => {
            await subject.backend.connect();
            await subject.settle();
            const target = await pickTarget(subject);
            await subject.backend.disconnect();
            await subject.settle();
            const outcome = await subject.backend.send(text(target, 'nobody home')).then(
              (r) => r,
              (e: unknown) => e,
            );
            if (options.sendWhileOffline === 'rejects') {
              expect(outcome).toBeInstanceOf(AppError);
            } else if (outcome instanceof Error) {
              expect(toAppError(outcome)).toBeInstanceOf(AppError);
            } else {
              expect(Number.isInteger((outcome as SendResult).sentAt)).toBe(true);
            }
          });
        },
      );
    });

    describe('errors', () => {
      if (options.unsupported) {
        const { call, kind } = options.unsupported;
        it(`rejects a method it can't serve as an AppError of kind "${kind}"`, async () => {
          await withSubject(async ({ backend, settle }) => {
            await backend.connect();
            await settle();
            const error = await rejection(call(backend));
            expect(error).toBeInstanceOf(AppError);
            expect(toAppError(error).kind).toBe(kind);
            if (kind === 'unsupported') expect(error).toBeInstanceOf(UnsupportedError);
          });
        });
      }

      if (options.connectFailureStatus) {
        const failedStatus = options.connectFailureStatus;
        it('fails a connect to an unreachable transport with a specific kind, then recovers', async () => {
          await withSubject(async ({ backend, settle, breakTransport, restoreTransport }) => {
            expect(breakTransport && restoreTransport).toBeTruthy();
            breakTransport?.();
            const error = await rejection(backend.connect());
            await settle();
            expect(TRANSPORT_FAILURE_KINDS).toContain(toAppError(error).kind);
            expect(backend.getStatus()).toBe(failedStatus);
            restoreTransport?.();
            await backend.connect();
            await settle();
            expect(backend.getStatus()).toBe('online');
          });
        });
      }

      it('surfaces a transport failure on send with a specific kind, and keeps working', async () => {
        await withSubject(async (subject) => {
          await subject.backend.connect();
          await subject.settle();
          const target = await pickTarget(subject);
          subject.breakTransport?.();
          const error = await rejection(subject.backend.send(text(target, 'lost')));
          const kind = toAppError(error).kind;
          expect(kind).not.toBe('unknown');
          expect(kind).not.toBe('internal');
          subject.restoreTransport?.();
          await expect(subject.backend.send(text(target, 'again'))).resolves.toMatchObject({
            sentAt: expect.any(Number) as unknown,
          });
        });
      });
    });
  });
}
