/**
 * Makes the demo feel inhabited: every few seconds someone in a "lively"
 * conversation types, sends a message or reacts. Runs entirely on the
 * injected scheduler, so tests can fast-forward it deterministically.
 */
import { messageId, type ConversationId, type Message } from '@/core/domain';
import type { Cancel, Clock, Scheduler } from '@/core/lib';
import type { BackendEvents } from '../types';
import type { Random } from './prng';
import { renderMockText, type MockWorld } from './world';

export interface LivelinessHost {
  world: MockWorld;
  clock: Clock;
  scheduler: Scheduler;
  rnd: Random;
  emit<E extends keyof BackendEvents>(event: E, payload: BackendEvents[E]): void;
  /** Adds an incoming message to the world and emits it. */
  deliver(message: Message): void;
}

export interface LivelinessOptions {
  /** Delay between activity ticks, uniformly drawn from [min, max] ms. */
  intervalMs?: [number, number];
}

const REACTIONS = ['👍', '❤️', '😂', '🎯', '🎉', '👀'];

export class Liveliness {
  private timers = new Set<Cancel>();
  private running = false;
  private readonly interval: [number, number];

  constructor(
    private readonly host: LivelinessHost,
    options: LivelinessOptions = {},
  ) {
    this.interval = options.intervalMs ?? [4_000, 9_000];
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
  }

  stop(): void {
    this.running = false;
    for (const cancel of this.timers) cancel();
    this.timers.clear();
  }

  /** Schedules a one-off reply from the peer of a DM (used after the user sends). */
  replyTo(conversationId: ConversationId): void {
    const conv = this.host.world.conversations.get(conversationId);
    if (!conv || !this.running) return;
    const others = conv.memberIds.filter((id) => id !== this.host.world.self.id);
    if (others.length === 0) return;
    this.typeThenSend(conversationId, this.host.rnd.pick(others), this.host.rnd.int(1_500, 4_000));
  }

  private later(ms: number, fn: () => void): void {
    const cancel = this.host.scheduler.setTimeout(() => {
      this.timers.delete(cancel);
      fn();
    }, ms);
    this.timers.add(cancel);
  }

  private scheduleTick(): void {
    const [min, max] = this.interval;
    this.later(this.host.rnd.int(min, max), () => {
      if (!this.running) return;
      this.tick();
      this.scheduleTick();
    });
  }

  private tick(): void {
    const { world, rnd } = this.host;
    if (world.lively.length === 0) return;
    const conversationId = rnd.pick(world.lively);
    const conv = world.conversations.get(conversationId);
    if (!conv) return;
    const others = conv.memberIds.filter((id) => id !== world.self.id);
    if (others.length === 0) return;
    const author = rnd.pick(others);
    const roll = rnd.next();

    if (roll < 0.65) {
      this.typeThenSend(conversationId, author, rnd.int(1_500, 4_500));
    } else if (roll < 0.9) {
      this.react(conversationId, author);
    } else {
      // Starts typing, thinks better of it.
      this.host.emit('typing', { conversationId, authorId: author, typing: true });
      this.later(rnd.int(1_000, 3_000), () => {
        this.host.emit('typing', { conversationId, authorId: author, typing: false });
      });
    }
  }

  private typeThenSend(conversationId: ConversationId, authorId: string, typingMs: number): void {
    const { world, rnd, clock } = this.host;
    this.host.emit('typing', { conversationId, authorId, typing: true });
    this.later(typingMs, () => {
      const conv = world.conversations.get(conversationId);
      if (!conv) return;
      const pool = world.pools.get(conversationId) ?? ['👋'];
      const { body, ranges } = renderMockText(
        rnd,
        rnd.pick(pool),
        authorId,
        world.self.id,
        conv.memberIds,
      );
      const sentAt = clock.now();
      this.host.emit('typing', { conversationId, authorId, typing: false });
      this.host.deliver({
        id: messageId(authorId, sentAt),
        conversationId,
        authorId,
        sentAt,
        receivedAt: sentAt,
        body,
        ranges,
        attachments: [],
        reactions: [],
        status: 'read',
        kind: 'normal',
      });
    });
  }

  private react(conversationId: ConversationId, authorId: string): void {
    const { world, rnd, clock } = this.host;
    const history = world.histories.get(conversationId) ?? [];
    const candidates = history.slice(-6).filter((m) => m.kind === 'normal' && !m.deleted);
    if (candidates.length === 0) return;
    const target = rnd.pick(candidates);
    const reaction = { emoji: rnd.pick(REACTIONS), authorId, at: clock.now() };
    target.reactions = [...target.reactions.filter((r) => r.authorId !== authorId), reaction];
    this.host.emit('reaction', {
      conversationId,
      targetAuthorId: target.authorId,
      targetSentAt: target.sentAt,
      reaction,
      remove: false,
    });
  }
}
