/**
 * Polls end to end through the services: incoming creates, votes and ends
 * (live, out of order, from our own other devices), what the sync engine
 * refuses, sending our own poll, vote and end with their rollbacks, and the
 * news that reaches notifications.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import {
  messageId,
  pendingMessageId,
  type ConversationId,
  type Message,
  type PollContent,
} from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores, messagesSelectors } from '@/core/stores';
import { HistoryService } from './HistoryService';
import { PendingOpsBuffer } from './PendingOpsBuffer';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService, type SyncEvents } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const onError = vi.fn();
  const receipts = new ReceiptBuffer();
  const pendingOps = new PendingOpsBuffer();
  const sync = new SyncService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    receipts,
    pendingOps,
    onError,
  });
  await sync.start();
  let n = 0;
  const send = new SendService({
    backend,
    repository,
    stores,
    clock: scheduler,
    receipts,
    pendingOps,
    onError,
    newNonce: () => `nonce-${++n}`,
  });
  const history = new HistoryService({ backend, repository, stores, pageSize: 20, onError });
  const selfId = backend.world.self.id;
  const group = [...backend.world.conversations.values()].find(
    (c) => c.kind === 'group' && c.memberIds.length > 2,
  )!;
  const others = group.memberIds.filter((m) => m !== selfId);
  const [ana, bo] = others as [string, string];
  // The conversation on screen: only an open one has its messages in the store.
  await history.open(group.id);
  const activity: SyncEvents['pollActivity'][] = [];
  sync.on('pollActivity', (e) => activity.push(e));
  const list = (id: ConversationId) => messagesSelectors.list(id)(stores.messages.getState());
  const stored = (id: ReturnType<typeof messageId>) => repository.get(id);
  return {
    scheduler,
    backend,
    repository,
    stores,
    sync,
    send,
    onError,
    selfId,
    group: group.id,
    ana,
    bo,
    activity,
    list,
    stored,
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

const pollOf = (extra: Partial<PollContent> = {}): PollContent => ({
  question: 'Where to eat?',
  options: ['Pizza', 'Ramen', 'Tacos'],
  allowMultiple: true,
  votes: [],
  ...extra,
});

const pollMessage = (
  conversationId: ConversationId,
  authorId: string,
  sentAt: number,
  poll: PollContent = pollOf(),
): Message => ({
  id: messageId(authorId, sentAt),
  conversationId,
  authorId,
  sentAt,
  receivedAt: sentAt,
  body: '',
  ranges: [],
  attachments: [],
  reactions: [],
  status: authorId === 'self' ? 'sent' : 'read',
  kind: 'normal',
  poll,
});

async function deliver(h: Harness, message: Message) {
  h.backend.deliver(message);
  await h.sync.idle();
}

async function vote(
  h: Harness,
  poll: Message,
  voterId: string,
  optionIndexes: number[],
  voteCount = 1,
  at = NOW + voteCount,
) {
  h.backend.emit('pollVote', {
    conversationId: poll.conversationId,
    targetAuthorId: poll.authorId,
    targetSentAt: poll.sentAt,
    voterId,
    optionIndexes,
    voteCount,
    at,
  });
  await h.sync.idle();
}

async function end(h: Harness, poll: Message, authorId = poll.authorId, at = NOW + 500) {
  h.backend.emit('pollTerminate', {
    conversationId: poll.conversationId,
    authorId,
    targetSentAt: poll.sentAt,
    at,
  });
  await h.sync.idle();
}

describe('SyncService: polls', () => {
  it('stores an incoming poll and applies votes to it, in the store and the repository', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await deliver(h, poll);
    await vote(h, poll, h.bo, [1]);
    await vote(h, poll, h.selfId, [0, 2]);
    const shown = h.list(h.group).find((m) => m.id === poll.id);
    expect(shown?.poll?.votes.map((v) => [v.voterId, v.optionIndexes])).toEqual([
      [h.bo, [1]],
      [h.selfId, [0, 2]],
    ]);
    expect((await h.stored(poll.id))?.poll?.votes).toHaveLength(2);
  });

  it('keeps the vote with the highest voteCount whatever order they arrive in', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await deliver(h, poll);
    await vote(h, poll, h.bo, [2], 3);
    await vote(h, poll, h.bo, [0], 2);
    await vote(h, poll, h.bo, [1], 1);
    expect((await h.stored(poll.id))?.poll?.votes.map((v) => v.optionIndexes)).toEqual([[2]]);
    await vote(h, poll, h.bo, [], 4);
    expect((await h.stored(poll.id))?.poll?.votes.map((v) => v.optionIndexes)).toEqual([[]]);
  });

  it('refuses votes for options the poll lacks, and several choices on a single-choice poll', async () => {
    const h = await setup();
    const multi = pollMessage(h.group, h.ana, NOW + 10);
    const single = pollMessage(h.group, h.ana, NOW + 11, pollOf({ allowMultiple: false }));
    await deliver(h, multi);
    await deliver(h, single);
    await vote(h, multi, h.bo, [7]);
    await vote(h, single, h.bo, [0, 1]);
    expect((await h.stored(multi.id))?.poll?.votes).toEqual([]);
    expect((await h.stored(single.id))?.poll?.votes).toEqual([]);
    await vote(h, single, h.bo, [1]);
    expect((await h.stored(single.id))?.poll?.votes).toHaveLength(1);
  });

  it('holds a vote that beats its poll and applies it when the poll arrives', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await vote(h, poll, h.bo, [1]);
    expect(await h.stored(poll.id)).toBeUndefined();
    await deliver(h, poll);
    expect((await h.stored(poll.id))?.poll?.votes.map((v) => [v.voterId, v.optionIndexes])).toEqual(
      [[h.bo, [1]]],
    );
    expect(h.list(h.group).find((m) => m.id === poll.id)?.poll?.votes).toHaveLength(1);
  });

  it('holds an end that beats its poll too', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await end(h, poll);
    await deliver(h, poll);
    expect((await h.stored(poll.id))?.poll?.ended).toBe(true);
  });

  it('applies a vote only to the poll in the conversation it was sent to', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await deliver(h, poll);
    const elsewhere = [...h.backend.world.conversations.keys()].find((id) => id !== h.group)!;
    h.backend.emit('pollVote', {
      conversationId: elsewhere,
      targetAuthorId: poll.authorId,
      targetSentAt: poll.sentAt,
      voterId: h.bo,
      optionIndexes: [0],
      voteCount: 1,
      at: NOW + 1,
    });
    h.backend.emit('pollTerminate', {
      conversationId: elsewhere,
      authorId: poll.authorId,
      targetSentAt: poll.sentAt,
      at: NOW + 2,
    });
    await h.sync.idle();
    const after = await h.stored(poll.id);
    expect(after?.poll?.votes).toEqual([]);
    expect(after?.poll?.ended).toBeUndefined();
  });

  it('ends a poll only for the person who wrote it', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await deliver(h, poll);
    // Bo "ending" a poll with Ana's timestamp targets a poll of Bo's, which doesn't exist.
    await end(h, poll, h.bo);
    expect((await h.stored(poll.id))?.poll?.ended).toBeUndefined();
    await end(h, poll, h.ana);
    expect((await h.stored(poll.id))?.poll?.ended).toBe(true);
  });

  it('ignores votes after the end, and says once who ended the poll', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await deliver(h, poll);
    await vote(h, poll, h.bo, [0]);
    await end(h, poll, h.ana, NOW + 500);
    await end(h, poll, h.ana, NOW + 500);
    await vote(h, poll, h.bo, [1], 2);
    const after = await h.stored(poll.id);
    expect(after?.poll?.ended).toBe(true);
    expect(after?.poll?.votes.map((v) => v.optionIndexes)).toEqual([[0]]);
    const lines = h
      .list(h.group)
      .filter((m) => m.kind === 'system' && m.systemText?.includes('poll'));
    expect(lines.map((m) => m.systemText)).toEqual([
      `${h.backend.world.contacts.get(h.ana)?.name ?? ''} ended the poll: Where to eat?`,
    ]);
    // The sidebar's latest message is that line.
    expect(h.stores.conversations.getState().lastMessage[h.group]?.systemText).toContain(
      'ended the poll',
    );
  });

  it('says "You ended the poll" when the end came from our own other device', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.selfId, NOW + 10);
    await deliver(h, poll);
    await end(h, poll, h.selfId);
    expect(h.list(h.group).at(-1)?.systemText).toBe('You ended the poll: Where to eat?');
    expect(h.activity).toEqual([]);
  });

  it('survives re-delivery of the poll without losing votes or the end', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await deliver(h, poll);
    await vote(h, poll, h.bo, [1]);
    await end(h, poll);
    await deliver(h, poll);
    const after = await h.stored(poll.id);
    expect(after?.poll?.votes).toHaveLength(1);
    expect(after?.poll?.ended).toBe(true);
  });

  it('turns a deleted poll into a deleted message that no vote can revive', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await deliver(h, poll);
    h.backend.emit('messageDeleted', {
      conversationId: h.group,
      authorId: h.ana,
      targetSentAt: poll.sentAt,
    });
    await h.sync.idle();
    await vote(h, poll, h.bo, [0]);
    const after = await h.stored(poll.id);
    expect(after?.deleted).toBe(true);
    expect(after?.poll).toBeUndefined();
  });
});

describe('SyncService: poll activity for notifications', () => {
  it('reports someone else voting on our poll, once, with the poll as it now stands', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.selfId, NOW + 10);
    await deliver(h, poll);
    await vote(h, poll, h.bo, [1]);
    await vote(h, poll, h.bo, [1]); // a repeat changes nothing
    expect(h.activity).toHaveLength(1);
    expect(h.activity[0]).toMatchObject({ kind: 'vote', actorId: h.bo, live: true });
    expect(h.activity[0]?.message.poll?.votes).toHaveLength(1);
  });

  it("is silent about our own votes, retractions, and votes on other people's polls", async () => {
    const h = await setup();
    const mine = pollMessage(h.group, h.selfId, NOW + 10);
    const theirs = pollMessage(h.group, h.ana, NOW + 11);
    await deliver(h, mine);
    await deliver(h, theirs);
    await vote(h, mine, h.selfId, [0]); // our other device
    await vote(h, mine, h.bo, [], 1); // nothing chosen
    await vote(h, theirs, h.bo, [0]);
    expect(h.activity).toEqual([]);
  });

  it('reports someone ending their poll, but not an end we already know about', async () => {
    const h = await setup();
    const poll = pollMessage(h.group, h.ana, NOW + 10);
    await deliver(h, poll);
    await end(h, poll);
    await end(h, poll);
    expect(h.activity.map((e) => [e.kind, e.actorId])).toEqual([['end', h.ana]]);
  });
});

describe('SendService: polls', () => {
  const draft = { question: '  Where to?  ', options: ['Crag', ' ', 'Gym'], allowMultiple: false };

  it('shows the poll at once and reconciles it to its real identity when sent', async () => {
    const h = await setup();
    const nonce = await h.send.sendPoll({ conversationId: h.group, poll: draft });
    expect(nonce).toBe('nonce-1');
    const sent = h.list(h.group).findLast((m) => m.authorId === h.selfId && m.poll)!;
    expect(sent.id).not.toBe(pendingMessageId('nonce-1'));
    expect(sent.status).toBe('sent');
    expect(sent.body).toBe('');
    expect(sent.poll).toEqual({
      question: 'Where to?',
      options: ['Crag', 'Gym'],
      allowMultiple: false,
      votes: [],
    });
    expect((await h.stored(sent.id))?.poll?.question).toBe('Where to?');
    expect(await h.stored(pendingMessageId('nonce-1'))).toBeUndefined();
    // The backend holds it too (the mock's history).
    expect(
      h.backend.world.histories.get(h.group)?.some((m) => m.poll?.question === 'Where to?'),
    ).toBe(true);
  });

  it('leaves a failed poll in the outbox with its poll, and retries it', async () => {
    const h = await setup();
    h.backend.failNext();
    await h.send.sendPoll({ conversationId: h.group, poll: draft });
    const failed = h.list(h.group).findLast((m) => m.authorId === h.selfId && m.poll)!;
    expect(failed).toMatchObject({ id: pendingMessageId('nonce-1'), status: 'failed' });
    expect(failed.poll?.options).toEqual(['Crag', 'Gym']);
    expect((await h.repository.listOutbox())[0]?.input.poll?.question).toBe('Where to?');
    await h.send.retry(h.group, 'nonce-1');
    const sent = h.list(h.group).findLast((m) => m.authorId === h.selfId && m.poll)!;
    expect(sent.status).toBe('sent');
    expect(sent.poll?.question).toBe('Where to?');
  });

  it('rebuilds an unsent poll from the outbox after a restart', async () => {
    const h = await setup();
    const input = {
      conversationId: h.group,
      body: '',
      ranges: [],
      poll: { question: 'Q?', options: ['a', 'b'], allowMultiple: true },
    };
    await h.repository.putOutbox({ nonce: 'old', input, createdAt: NOW });
    await h.send.restoreOutbox();
    const row = h.list(h.group).find((m) => m.id === pendingMessageId('old'));
    expect(row).toMatchObject({ status: 'failed', poll: { question: 'Q?', votes: [] } });
  });

  it('refuses a poll that is not valid, and does nothing without a backend that can vote', async () => {
    const h = await setup();
    await expect(
      h.send.sendPoll({ conversationId: h.group, poll: { ...draft, options: ['only one'] } }),
    ).rejects.toThrow(/can't be sent/u);
    Object.assign(h.backend, { votePoll: undefined });
    expect(await h.send.sendPoll({ conversationId: h.group, poll: draft })).toBeNull();
    expect(h.send.capabilities.polls).toBe(false);
  });

  it("applies a vote that beat the poll's own acknowledgement", async () => {
    const h = await setup();
    // Hold the mock's reply so the vote can land while the poll is still pending.
    const original = h.backend.send.bind(h.backend);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.backend.send = async (input) => {
      const result = await original(input);
      await gate;
      return result;
    };
    const sending = h.send.sendPoll({ conversationId: h.group, poll: draft });
    await flush();
    const sentAt = h.backend.world.histories.get(h.group)!.findLast((m) => m.poll)!.sentAt;
    h.backend.emit('pollVote', {
      conversationId: h.group,
      targetAuthorId: h.selfId,
      targetSentAt: sentAt,
      voterId: h.bo,
      optionIndexes: [1],
      voteCount: 1,
      at: sentAt + 1,
    });
    await h.sync.idle();
    release();
    await sending;
    await flush();
    const shown = h.list(h.group).findLast((m) => m.authorId === h.selfId && m.poll)!;
    expect(shown.poll?.votes.map((v) => [v.voterId, v.optionIndexes])).toEqual([[h.bo, [1]]]);
  });

  let sentAt = NOW + 20;
  /** Somebody else's poll, in the backend's history and on screen; each has its own timestamp. */
  async function ownPoll(h: Harness, poll: Partial<PollContent> = {}) {
    const message = pollMessage(h.group, h.ana, ++sentAt, pollOf(poll));
    h.backend.world.histories.get(h.group)!.push(message);
    await deliver(h, message);
    return h.list(h.group).find((m) => m.id === message.id)!;
  }

  it("shows our vote at once, numbers it, and sends it to the poll's author", async () => {
    const h = await setup();
    const poll = await ownPoll(h);
    const spy = vi.spyOn(h.backend, 'votePoll');
    expect(await h.send.votePoll(h.group, poll, [0, 2])).toBe('done');
    expect(spy).toHaveBeenLastCalledWith({
      conversationId: h.group,
      pollAuthorId: h.ana,
      pollSentAt: poll.sentAt,
      optionIndexes: [0, 2],
      voteCount: 1,
    });
    const after = h.list(h.group).find((m) => m.id === poll.id)!;
    expect(after.poll?.votes).toMatchObject([
      { voterId: h.selfId, optionIndexes: [0, 2], voteCount: 1 },
    ]);
    expect((await h.stored(poll.id))?.poll?.votes).toHaveLength(1);
    // Changing it counts up; retracting it is a vote too.
    expect(await h.send.votePoll(h.group, after, [1])).toBe('done');
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ optionIndexes: [1], voteCount: 2 }),
    );
    const again = h.list(h.group).find((m) => m.id === poll.id)!;
    expect(await h.send.votePoll(h.group, again, [])).toBe('done');
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ optionIndexes: [], voteCount: 3 }),
    );
  });

  it('takes our vote back, and reports it, when it cannot be sent', async () => {
    const h = await setup();
    const poll = await ownPoll(h, {
      votes: [{ voterId: h.selfId, optionIndexes: [1], voteCount: 4, at: NOW }],
    });
    h.backend.failNext();
    expect(await h.send.votePoll(h.group, poll, [0])).toBe('failed');
    const after = h.list(h.group).find((m) => m.id === poll.id)!;
    expect(after.poll?.votes).toEqual([
      { voterId: h.selfId, optionIndexes: [1], voteCount: 4, at: NOW },
    ]);
    expect((await h.stored(poll.id))?.poll?.votes[0]?.optionIndexes).toEqual([1]);
    expect(h.onError).toHaveBeenCalled();
    // The first vote of all rolls back to no vote.
    const fresh = pollMessage(h.group, h.ana, NOW + 30);
    await deliver(h, fresh);
    h.backend.world.histories.get(h.group)!.push(fresh);
    h.backend.failNext();
    expect(await h.send.votePoll(h.group, fresh, [0])).toBe('failed');
    expect(h.list(h.group).find((m) => m.id === fresh.id)?.poll?.votes).toEqual([]);
  });

  it('does nothing for a vote the poll would not take', async () => {
    const h = await setup();
    const poll = await ownPoll(h);
    const spy = vi.spyOn(h.backend, 'votePoll');
    expect(await h.send.votePoll(h.group, poll, [5])).toBe('ignored');
    expect(await h.send.votePoll(h.group, poll, [0, 0])).toBe('ignored');
    const single = await ownPoll(h, { allowMultiple: false });
    expect(await h.send.votePoll(h.group, single, [0, 1])).toBe('ignored');
    // An unchanged answer is nothing to send either.
    expect(await h.send.votePoll(h.group, poll, [])).toBe('ignored');
    const ended = await ownPoll(h, { ended: true });
    expect(await h.send.votePoll(h.group, ended, [0])).toBe('ignored');
    const pending = { ...poll, id: pendingMessageId('x') };
    expect(await h.send.votePoll(h.group, pending, [0])).toBe('ignored');
    expect(spy).not.toHaveBeenCalled();
  });

  it('lets a second change wait for the first rather than stack on it', async () => {
    const h = await setup();
    const poll = await ownPoll(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const votePoll = h.backend.votePoll.bind(h.backend);
    h.backend.votePoll = async (input) => {
      await gate;
      await votePoll(input);
    };
    const first = h.send.votePoll(h.group, poll, [0]);
    expect(await h.send.votePoll(h.group, poll, [1])).toBe('ignored');
    release();
    expect(await first).toBe('done');
  });

  it('ends our poll at once, says so in the chat, and can take it back', async () => {
    const h = await setup();
    const mine = pollMessage(h.group, h.selfId, NOW + 40);
    h.backend.world.histories.get(h.group)!.push(mine);
    await deliver(h, mine);
    const shown = h.list(h.group).find((m) => m.id === mine.id)!;
    expect(await h.send.endPoll(h.group, shown)).toBe('done');
    expect(h.list(h.group).find((m) => m.id === mine.id)?.poll?.ended).toBe(true);
    expect((await h.stored(mine.id))?.poll?.ended).toBe(true);
    expect(h.list(h.group).at(-1)).toMatchObject({
      kind: 'system',
      systemText: 'You ended the poll: Where to eat?',
    });
    // Ending twice is nothing to do.
    expect(
      await h.send.endPoll(
        h.group,
        h.list(h.group).find((m) => m.id === mine.id)!,
      ),
    ).toBe('ignored');
  });

  it('reopens the poll, and writes no line, when the end cannot be sent', async () => {
    const h = await setup();
    const mine = pollMessage(h.group, h.selfId, NOW + 40);
    h.backend.world.histories.get(h.group)!.push(mine);
    await deliver(h, mine);
    const before = h.list(h.group).length;
    h.backend.failNext();
    expect(
      await h.send.endPoll(
        h.group,
        h.list(h.group).find((m) => m.id === mine.id)!,
      ),
    ).toBe('failed');
    expect(h.list(h.group).find((m) => m.id === mine.id)?.poll?.ended).toBeUndefined();
    expect(h.list(h.group)).toHaveLength(before);
  });

  it('lets only the author end a poll, and never an unsent one', async () => {
    const h = await setup();
    const theirs = await ownPoll(h);
    const spy = vi.spyOn(h.backend, 'terminatePoll');
    expect(await h.send.endPoll(h.group, theirs)).toBe('ignored');
    const mine = { ...pollMessage(h.group, h.selfId, NOW + 41), id: pendingMessageId('y') };
    expect(await h.send.endPoll(h.group, mine)).toBe('ignored');
    expect(spy).not.toHaveBeenCalled();
  });
});
