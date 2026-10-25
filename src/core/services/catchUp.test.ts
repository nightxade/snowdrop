import { describe, expect, it } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import {
  CATCH_UP_CEILING_MS,
  CATCH_UP_QUIET_MS,
  NOTIFICATION_HOLD_CEILING_MS,
} from './CatchUpTracker';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

async function setup(options: { catchingUpSignal?: boolean } = {}) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  backend.catchingUpSignalSupported = options.catchingUpSignal ?? false;
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

  it('with the capability the hold outlasts the sidebar ceiling, up to the long one', async () => {
    const ctx = await setup({ catchingUpSignal: true });
    ctx.backend.emit('catchingUp', undefined);

    // A long backlog: messages keep coming, so only the ceilings can end it.
    await drainFor(ctx, CATCH_UP_CEILING_MS / 1_000 + 1);
    expect(ctx.session().catchingUp).toBe(false);
    expect(ctx.session().notificationsHeld).toBe(true);
    expect(ctx.arrivals.every((a) => a.held)).toBe(true);

    await drainFor(ctx, NOTIFICATION_HOLD_CEILING_MS / 1_000 - CATCH_UP_CEILING_MS / 1_000 - 2);
    expect(ctx.session().notificationsHeld).toBe(true);
    await drainFor(ctx, 3);
    expect(ctx.session().notificationsHeld).toBe(false);
    expect(ctx.arrivals.at(-1)!.held).toBe(false);
  });

  it('a capable backend that goes offline and comes back also gets the long hold', async () => {
    const ctx = await setup({ catchingUpSignal: true });
    ctx.backend.emit('status', 'offline');
    ctx.backend.emit('status', 'online');
    expect(ctx.session().notificationsHeld).toBe(true);
    await drainFor(ctx, CATCH_UP_CEILING_MS / 1_000 + 1);
    expect(ctx.session().catchingUp).toBe(false);
    expect(ctx.session().notificationsHeld).toBe(true);
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
