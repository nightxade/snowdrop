/**
 * `createSnowdrop` on a backend that fails, stalls and reorders on cue
 * (src/test/FaultyBackend.ts): what a slow or flaky daemon does to the
 * session, at the level the user sees it.
 */
import { describe, expect, it } from 'vitest';
import type { ChatBackend } from '@/core/backend';
import { MockBackend } from '@/core/backend/mock';
import { messageId } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { faultyBackend, type FaultyBackend, type FaultyOptions } from '@/test/FaultyBackend';
import { BackendRegistry, BUILTIN_BACKENDS } from './backends';
import { createSnowdrop } from './createSnowdrop';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

/** The demo backend behind a `FaultyBackend`, registered as the default ("mock") transport. */
function boot(options: (scheduler: ManualScheduler) => FaultyOptions) {
  const scheduler = new ManualScheduler(NOW);
  let inner!: MockBackend;
  let faulty!: FaultyBackend;
  const started: ChatBackend[] = [];
  let attached = 0;
  const demo = BUILTIN_BACKENDS.find((b) => b.kind === 'mock')!;
  const registry = new BackendRegistry([
    {
      ...demo,
      load: () =>
        Promise.resolve(() => {
          inner = new MockBackend({ latencyMs: 0, scheduler, clock: scheduler });
          faulty = faultyBackend(inner, options(scheduler));
          return faulty;
        }),
      onStarted: (backend) => {
        started.push(backend);
      },
      attach: () => {
        attached++;
        return () => undefined;
      },
    },
  ]);
  const snowdrop = createSnowdrop({
    storage: createMemoryStorage(),
    clock: scheduler,
    scheduler,
    backends: registry,
  });
  return {
    snowdrop,
    scheduler,
    get inner() {
      return inner;
    },
    get faulty() {
      return faulty;
    },
    started,
    attached: () => attached,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('createSnowdrop on a faulty backend', () => {
  it('recovers from a failed first connect on Retry, running the post-connect steps once', async () => {
    const t = boot(() => ({ failFirst: ['connect'] }));
    const { stores, sync } = t.snowdrop;

    await expect(t.snowdrop.start()).rejects.toMatchObject({ kind: 'unreachable' });
    expect(stores.session.getState().phase).toBe('failed');
    // Nothing that belongs to a connected session ran.
    expect(t.started).toHaveLength(0);
    expect(t.attached()).toBe(0);

    // The Retry button: `sync.start()` again.
    await sync.start();
    await sync.settled();
    expect(stores.session.getState().phase).toBe('ready');
    expect(stores.session.getState().error).toBeNull();
    expect(t.faulty.calls('connect')).toBe(2);
    expect(t.started).toHaveLength(1);
    expect(t.attached()).toBe(1);

    // A further start() is a no-op: the steps are not run again.
    await t.snowdrop.start();
    await sync.settled();
    expect(t.started).toHaveLength(1);
    expect(t.attached()).toBe(1);
    await t.snowdrop.dispose();
  });

  it('keeps connecting while listContacts is slow, parking live messages and applying them once ready', async () => {
    // The initial sync needs the contact list (names in the sidebar), so the
    // session stays `connecting` until it answers; what arrives meanwhile is
    // parked behind the sync, not dropped and not shown early.
    const t = boot((scheduler) => ({ delay: { listContacts: 3_000 }, scheduler }));
    const { stores, sync } = t.snowdrop;

    const started = t.snowdrop.start();
    await settle();
    expect(stores.session.getState().phase).toBe('connecting');

    const conversationId = Object.values(
      (await t.inner.listConversations()).filter((c) => c.kind === 'direct'),
    )[0]!.id;
    const authorId = 'someone-else';
    const arrived = makeMessage({ conversationId, authorId, sentAt: NOW + 1, body: 'during sync' });
    const applied: string[] = [];
    sync.on('message', (m) => applied.push(m.body));
    // `emit`, not `deliver`: the demo's `deliver` also adds the message to its own
    // history, which the initial sync would then read as an older copy.
    t.inner.emit('message', arrived);
    await settle();
    expect(applied).toEqual([]);
    expect(stores.session.getState().phase).toBe('connecting');

    t.scheduler.advance(3_000);
    await started;
    await sync.idle();
    expect(stores.session.getState().phase).toBe('ready');
    expect(applied).toEqual(['during sync']);
    expect(await t.snowdrop.repository.get(messageId(authorId, NOW + 1))).toBeDefined();
    await t.snowdrop.dispose();
  });

  it('ends catching up only after every message delivered before caughtUp is stored', async () => {
    // caughtUp is held back and handed over right behind two messages, while
    // the initial sync is still running: all three are parked and replayed in
    // order, so catching-up must not end before the second message is stored.
    const t = boot((scheduler) => ({
      delay: { listContacts: 3_000 },
      scheduler,
      holdEvent: ['caughtUp'],
    }));
    const { stores, sync } = t.snowdrop;
    const log: string[] = [];
    sync.on('message', (m) => log.push(`message:${m.body}`));
    stores.session.subscribe((s, prev) => {
      if (s.catchingUp !== prev.catchingUp) log.push(`catchingUp:${String(s.catchingUp)}`);
    });

    const started = t.snowdrop.start();
    await settle();
    const conversationId = (await t.inner.listConversations()).find((c) => c.kind === 'direct')!.id;
    for (const [i, body] of ['first', 'second'].entries())
      t.inner.emit(
        'message',
        makeMessage({ conversationId, authorId: 'someone-else', sentAt: NOW + 1 + i, body }),
      );
    expect(t.faulty.held('caughtUp')).toBe(1);
    t.faulty.release('caughtUp');
    await settle();

    t.scheduler.advance(3_000);
    await started;
    await sync.idle();
    expect(log.indexOf('catchingUp:false')).toBeGreaterThan(log.indexOf('message:second'));
    expect(log.indexOf('message:second')).toBeGreaterThan(log.indexOf('message:first'));
    expect(stores.session.getState().catchingUp).toBe(false);
    await t.snowdrop.dispose();
  });
});
