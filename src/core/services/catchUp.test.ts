import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { addLogSink, ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import {
  CATCH_UP_CEILING_MS,
  CATCH_UP_QUIET_MS,
  SIGNALLED_CATCH_UP_CEILING_MS,
} from './CatchUpTracker';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

async function setup(options: { catchingUpSignal?: boolean; ordered?: boolean } = {}) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  backend.capabilities.setFeature('orderedCatchingUp', options.ordered ?? false);
  backend.capabilities.setFeature(
    'catchingUpSignal',
    options.catchingUpSignal ?? options.ordered ?? false,
  );
  const stores = createStores();
  const sync = new SyncService({
    backend,
    repository: new MemoryMessageRepository(),
    stores,
    clock: scheduler,
    scheduler,
    onError: () => undefined,
  });
  await sync.start();
  await sync.idle();
  const conv: ConversationId = backend.world.conversationIds.get('crux')!;
  const peer = backend.world.conversations
    .get(conv)!
    .memberIds.find((m) => m !== backend.world.self.id)!;
  // What `NotificationService` would see when each message finishes processing.
  const arrivals: { sentAt: number; held: boolean }[] = [];
  sync.on('messageArrived', ({ message }) => {
    arrivals.push({ sentAt: message.sentAt, held: stores.session.getState().notificationsHeld });
  });
  let next = NOW + 1;
  const build = (): Message => {
    const sentAt = next++;
    return {
      id: messageId(peer, sentAt),
      conversationId: conv,
      authorId: peer,
      sentAt,
      receivedAt: sentAt,
      body: 'hello',
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'read',
      kind: 'normal',
    };
  };
  const arrive = async () => {
    backend.deliver(build());
    await sync.idle();
  };
  const session = () => stores.session.getState();
  return { backend, scheduler, sync, stores, session, arrivals, arrive, build };
}

/** Delivers one message a second until `seconds` have passed, keeping the quiet timer from ending it. */
async function drainFor(ctx: Awaited<ReturnType<typeof setup>>, seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    ctx.scheduler.advance(1_000);
    await ctx.arrive();
  }
}

describe('the hold on the first connect', () => {
  /** A backend that only learns what the build can do while connecting, like signal-cli. */
  async function connectLate(ordered: boolean) {
    const scheduler = new ManualScheduler(NOW);
    const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
    backend.capabilities.setFeature('orderedCatchingUp', false);
    backend.capabilities.setFeature('catchingUpSignal', false);
    const realConnect = backend.connect.bind(backend);
    const realEmit = backend.emit.bind(backend);
    vi.spyOn(backend, 'connect').mockImplementation(async () => {
      // Unlike the demo backend, signal-cli sends caughtUp only once the
      // server's queue has drained, never as part of connecting.
      const emit = vi.spyOn(backend, 'emit').mockImplementation((event, payload) => {
        if (event !== 'caughtUp') realEmit(event, payload);
      });
      await realConnect();
      emit.mockRestore();
      backend.capabilities.setFeature('catchingUpSignal', true);
      backend.capabilities.setFeature('orderedCatchingUp', ordered);
    });
    const stores = createStores();
    const sync = new SyncService({
      backend,
      repository: new MemoryMessageRepository(),
      stores,
      clock: scheduler,
      scheduler,
      onError: () => undefined,
    });
    const log = await captureSyncLog(async () => {
      await sync.start();
      await sync.idle();
    });
    const starts = log.filter((l) => l.includes('catch-up started'));
    return { backend, scheduler, sync, session: () => stores.session.getState(), starts };
  }

  it('is strict, with the long ceiling, on a build that orders catchingUp, though the version is only known after connecting', async () => {
    const { backend, scheduler, sync, session, starts } = await connectLate(true);
    expect(
      starts.map((l) => /"strict":(true|false),"restarted":(true|false)/u.exec(l)?.[0]),
    ).toEqual(['"strict":false,"restarted":false', '"strict":true,"restarted":true']);
    expect(session().notificationsHeld).toBe(true);
    // Neither the quiet period nor the short ceiling ends it, for the sidebar either.
    scheduler.advance(CATCH_UP_CEILING_MS + CATCH_UP_QUIET_MS);
    expect(session().catchingUp).toBe(true);
    expect(session().notificationsHeld).toBe(true);
    backend.emit('caughtUp', undefined);
    await sync.idle();
    expect(session().catchingUp).toBe(false);
    expect(session().notificationsHeld).toBe(false);
  });

  it('gets the long ceiling, and the quiet period, on a build that only sends caughtUp', async () => {
    const { scheduler, session, starts } = await connectLate(false);
    expect(starts).toHaveLength(2);
    expect(starts.every((l) => l.includes('"strict":false'))).toBe(true);
    scheduler.advance(CATCH_UP_QUIET_MS);
    expect(session().notificationsHeld).toBe(false);
  });
});

describe('catching up after signal-cli reconnects by itself', () => {
  it('a catchingUp mid-session holds notifications until caughtUp', async () => {
    const { backend, session, arrivals, arrive, sync } = await setup({ catchingUpSignal: true });
    expect(session().notificationsHeld).toBe(false);

    backend.emit('catchingUp', undefined);
    expect(session().catchingUp).toBe(true);
    expect(session().notificationsHeld).toBe(true);
    await arrive();
    await arrive();
    expect(arrivals.map((a) => a.held)).toEqual([true, true]);

    backend.emit('caughtUp', undefined);
    await sync.idle();
    expect(session().catchingUp).toBe(false);
    expect(session().notificationsHeld).toBe(false);
    await arrive();
    expect(arrivals.map((a) => a.held)).toEqual([true, true, false]);
  });

  it('caughtUp is queued behind the messages before it, so none of them notify', async () => {
    const { backend, session, arrivals, sync, build } = await setup({ catchingUpSignal: true });
    backend.emit('catchingUp', undefined);
    backend.deliver(build());
    backend.emit('caughtUp', undefined);
    await sync.idle();
    expect(arrivals.map((a) => a.held)).toEqual([true]);
    expect(session().notificationsHeld).toBe(false);
  });

  it('if caughtUp overtakes catchingUp on an empty queue, the quiet period still ends it', async () => {
    const { backend, scheduler, session, sync } = await setup({ catchingUpSignal: true });
    backend.emit('caughtUp', undefined);
    await sync.idle();
    backend.emit('catchingUp', undefined);
    expect(session().catchingUp).toBe(true);
    expect(session().notificationsHeld).toBe(true);

    scheduler.advance(CATCH_UP_QUIET_MS - 1);
    expect(session().notificationsHeld).toBe(true);
    scheduler.advance(1);
    expect(session().catchingUp).toBe(false);
    expect(session().notificationsHeld).toBe(false);
  });

  it('with the capability the sidebar and the hold both last past the short ceiling, up to the long one', async () => {
    const ctx = await setup({ catchingUpSignal: true });
    ctx.backend.emit('catchingUp', undefined);

    // A long backlog: messages keep coming, so only the ceilings can end it.
    // The sidebar stays frozen ("Loading…") for as long as notifications are held.
    await drainFor(ctx, CATCH_UP_CEILING_MS / 1_000 + 1);
    expect(ctx.session().catchingUp).toBe(true);
    expect(ctx.session().notificationsHeld).toBe(true);
    expect(ctx.arrivals.every((a) => a.held)).toBe(true);

    await drainFor(ctx, SIGNALLED_CATCH_UP_CEILING_MS / 1_000 - CATCH_UP_CEILING_MS / 1_000 - 2);
    expect(ctx.session().catchingUp).toBe(true);
    expect(ctx.session().notificationsHeld).toBe(true);
    await drainFor(ctx, 3);
    expect(ctx.session().catchingUp).toBe(false);
    expect(ctx.session().notificationsHeld).toBe(false);
    expect(ctx.arrivals.at(-1)!.held).toBe(false);
  });

  it('a capable backend that goes offline and comes back also gets the long ceiling, sidebar included', async () => {
    const ctx = await setup({ catchingUpSignal: true });
    ctx.backend.emit('status', 'offline');
    ctx.backend.emit('status', 'online');
    expect(ctx.session().notificationsHeld).toBe(true);
    await drainFor(ctx, CATCH_UP_CEILING_MS / 1_000 + 1);
    expect(ctx.session().catchingUp).toBe(true);
    expect(ctx.session().notificationsHeld).toBe(true);
  });

  it('a brief drop that only reports connecting before coming back holds notifications too', async () => {
    const ctx = await setup();
    expect(ctx.session().notificationsHeld).toBe(false);
    ctx.backend.emit('status', 'connecting');
    expect(ctx.session().notificationsHeld).toBe(false);
    ctx.backend.emit('status', 'online');
    expect(ctx.session().catchingUp).toBe(true);
    expect(ctx.session().notificationsHeld).toBe(true);
    ctx.scheduler.advance(CATCH_UP_QUIET_MS);
    expect(ctx.session().notificationsHeld).toBe(false);
  });

  it('an online report while already online holds nothing', async () => {
    const ctx = await setup();
    ctx.backend.emit('status', 'online');
    expect(ctx.session().catchingUp).toBe(false);
    expect(ctx.session().notificationsHeld).toBe(false);
  });

  it('the first connect starts one catch-up, not a second one when the stream reports online', async () => {
    const lines = await captureSyncLog(async () => {
      await setup();
    });
    expect(lines.filter((l) => l.includes('catch-up started'))).toHaveLength(1);
  });

  it('without the capability both end at the same short ceiling, as before', async () => {
    const ctx = await setup({ catchingUpSignal: false });
    ctx.backend.emit('status', 'offline');
    ctx.backend.emit('status', 'online');
    expect(ctx.session().catchingUp).toBe(true);
    expect(ctx.session().notificationsHeld).toBe(true);

    await drainFor(ctx, CATCH_UP_CEILING_MS / 1_000 - 1);
    expect(ctx.session().catchingUp).toBe(true);
    expect(ctx.session().notificationsHeld).toBe(true);
    await drainFor(ctx, 2);
    expect(ctx.session().catchingUp).toBe(false);
    expect(ctx.session().notificationsHeld).toBe(false);
  });
});

/** The sync log lines written while `run` runs, as `level text`. */
async function captureSyncLog(run: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const remove = addLogSink({
    write(level, scope, message) {
      if (scope === 'sync') lines.push(`${level} ${message}`);
    },
  });
  try {
    await run();
  } finally {
    remove();
  }
  return lines;
}

describe('a backend that orders catchingUp before every message of the connection', () => {
  it('holds through a long silence after catchingUp and ends only on caughtUp', async () => {
    const ctx = await setup({ ordered: true });
    ctx.backend.emit('catchingUp', undefined);
    expect(ctx.session().notificationsHeld).toBe(true);

    // After a wake the first queued message can take far longer than the quiet period.
    ctx.scheduler.advance(5_000);
    expect(ctx.session().notificationsHeld).toBe(true);
    await ctx.arrive();
    ctx.scheduler.advance(CATCH_UP_QUIET_MS * 4);
    await ctx.arrive();
    expect(ctx.session().notificationsHeld).toBe(true);
    // The sidebar stays frozen through the same silences: previews never cycle mid-drain.
    expect(ctx.session().catchingUp).toBe(true);

    ctx.backend.emit('caughtUp', undefined);
    await ctx.sync.idle();
    expect(ctx.session().catchingUp).toBe(false);
    expect(ctx.session().notificationsHeld).toBe(false);
    expect(ctx.arrivals.map((a) => a.held)).toEqual([true, true]);
    await ctx.arrive();
    expect(ctx.arrivals.at(-1)!.held).toBe(false);
  });

  it('an empty queue still ends on caughtUp, after catchingUp', async () => {
    const ctx = await setup({ ordered: true });
    ctx.backend.emit('catchingUp', undefined);
    ctx.scheduler.advance(10_000);
    expect(ctx.session().notificationsHeld).toBe(true);
    ctx.backend.emit('caughtUp', undefined);
    await ctx.sync.idle();
    expect(ctx.session().notificationsHeld).toBe(false);
  });

  it('ends at the long ceiling when caughtUp never comes, and says so at warn', async () => {
    const ctx = await setup({ ordered: true });
    const lines = await captureSyncLog(() => {
      ctx.backend.emit('catchingUp', undefined);
      ctx.scheduler.advance(SIGNALLED_CATCH_UP_CEILING_MS - 1);
      expect(ctx.session().notificationsHeld).toBe(true);
      ctx.scheduler.advance(1);
    });
    expect(ctx.session().notificationsHeld).toBe(false);
    expect(lines).toEqual([
      'info catch-up started {"strict":true,"restarted":false}',
      'warn catch-up ended by its ceiling before caughtUp {"reason":"ceiling","strict":true,"messages":0}',
    ]);
  });

  it('logs when a hold starts and ends with the reason and a count, and no content', async () => {
    const ctx = await setup({ ordered: true });
    const lines = await captureSyncLog(async () => {
      ctx.backend.emit('catchingUp', undefined);
      await ctx.arrive();
      await ctx.arrive();
      ctx.backend.emit('caughtUp', undefined);
      await ctx.sync.idle();
    });
    expect(lines).toEqual([
      'info catch-up started {"strict":true,"restarted":false}',
      'info catch-up ended {"reason":"caughtUp","strict":true,"messages":2}',
    ]);
  });

  it('a second catchingUp after a sleep restarts the hold with a full ceiling', async () => {
    const ctx = await setup({ ordered: true });
    ctx.backend.emit('catchingUp', undefined);
    // The computer sleeps with the hold still open; on wake its clock is far ahead
    // and the new connection announces itself again before anything else.
    ctx.scheduler.advance(SIGNALLED_CATCH_UP_CEILING_MS - 1_000);
    expect(ctx.session().notificationsHeld).toBe(true);
    const lines = await captureSyncLog(() => {
      ctx.backend.emit('catchingUp', undefined);
    });
    expect(lines).toEqual(['info catch-up started {"strict":true,"restarted":true}']);
    ctx.scheduler.advance(SIGNALLED_CATCH_UP_CEILING_MS - 1);
    expect(ctx.session().notificationsHeld).toBe(true);
    ctx.scheduler.advance(1);
    expect(ctx.session().notificationsHeld).toBe(false);
  });

  it('a hold whose ceiling already ran during the sleep is held again by the next catchingUp', async () => {
    const ctx = await setup({ ordered: true });
    ctx.backend.emit('catchingUp', undefined);
    // The ceiling timer runs first on wake...
    ctx.scheduler.advance(SIGNALLED_CATCH_UP_CEILING_MS);
    expect(ctx.session().notificationsHeld).toBe(false);
    // ...and the new connection's catchingUp comes before any of its messages.
    ctx.backend.emit('catchingUp', undefined);
    await ctx.arrive();
    expect(ctx.arrivals.map((a) => a.held)).toEqual([true]);
  });

  it('a caughtUp that was already waiting when a newer catch-up began does not end it', async () => {
    const ctx = await setup({ ordered: true });
    ctx.backend.emit('catchingUp', undefined);
    // The old connection's caughtUp is queued behind a message still being processed...
    ctx.backend.deliver(ctx.build());
    ctx.backend.emit('caughtUp', undefined);
    // ...when the next connection announces itself.
    const lines = await captureSyncLog(async () => {
      ctx.backend.emit('catchingUp', undefined);
      await ctx.sync.idle();
    });
    expect(ctx.session().notificationsHeld).toBe(true);
    expect(lines).toContain('info ignored a caughtUp that belongs to an earlier catch-up');
    // The new connection's own caughtUp ends it.
    ctx.backend.emit('caughtUp', undefined);
    await ctx.sync.idle();
    expect(ctx.session().notificationsHeld).toBe(false);
  });

  describe('together with our own stream dropping and coming back', () => {
    it('a stream drop alone on a capable backend ends by the quiet period, as there may be no caughtUp', async () => {
      const ctx = await setup({ ordered: true });
      ctx.backend.emit('status', 'offline');
      ctx.backend.emit('status', 'online');
      expect(ctx.session().notificationsHeld).toBe(true);
      ctx.scheduler.advance(CATCH_UP_QUIET_MS);
      expect(ctx.session().notificationsHeld).toBe(false);
    });

    it('catchingUp after the stream is back upgrades the hold, even if the quiet period already ended it', async () => {
      const ctx = await setup({ ordered: true });
      ctx.backend.emit('status', 'offline');
      ctx.backend.emit('status', 'online');
      ctx.scheduler.advance(5_000);
      expect(ctx.session().notificationsHeld).toBe(false);

      ctx.backend.emit('catchingUp', undefined);
      expect(ctx.session().notificationsHeld).toBe(true);
      ctx.scheduler.advance(5_000);
      await ctx.arrive();
      expect(ctx.arrivals.map((a) => a.held)).toEqual([true]);
      ctx.backend.emit('caughtUp', undefined);
      await ctx.sync.idle();
      expect(ctx.session().notificationsHeld).toBe(false);
    });

    it('the stream coming back after catchingUp does not loosen the strict hold', async () => {
      const ctx = await setup({ ordered: true });
      ctx.backend.emit('catchingUp', undefined);
      ctx.backend.emit('status', 'offline');
      ctx.backend.emit('status', 'online');
      ctx.scheduler.advance(5_000);
      expect(ctx.session().notificationsHeld).toBe(true);
      await ctx.arrive();
      expect(ctx.arrivals.map((a) => a.held)).toEqual([true]);
      ctx.backend.emit('caughtUp', undefined);
      await ctx.sync.idle();
      expect(ctx.session().notificationsHeld).toBe(false);
    });
  });
});

describe('older builds keep the quiet-period fallback', () => {
  it('a build with catchingUp but without the ordering still ends the hold on the quiet period', async () => {
    const ctx = await setup({ catchingUpSignal: true, ordered: false });
    const lines = await captureSyncLog(() => {
      ctx.backend.emit('catchingUp', undefined);
      ctx.scheduler.advance(CATCH_UP_QUIET_MS);
    });
    expect(ctx.session().notificationsHeld).toBe(false);
    expect(lines).toEqual([
      'info catch-up started {"strict":false,"restarted":false}',
      'info catch-up ended {"reason":"quiet","strict":false,"messages":0}',
    ]);
  });

  it('a build with no catchingUp ends on the quiet period after a reconnect, as before', async () => {
    const ctx = await setup();
    ctx.backend.emit('status', 'offline');
    ctx.backend.emit('status', 'online');
    ctx.scheduler.advance(CATCH_UP_QUIET_MS);
    expect(ctx.session().notificationsHeld).toBe(false);
  });
});
