import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import type { ChatBackend, IdentityTrust } from '@/core/backend';
import { directConversationId, type ConversationId } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { acceptForOutgoing, createStores, selectMessageRequestState } from '@/core/stores';
import { IdentityService } from './IdentityService';
import { MessageRequestService } from './MessageRequestService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
/** After everything the demo chats hold, so the phone's answer is the newest thing. */
const AT = NOW + 60_000;

/** Everything that would tell the phone or the other person something. */
const OUTGOING = [
  'send',
  'edit',
  'react',
  'markRead',
  'setTyping',
  'setBlocked',
  'respondToMessageRequest',
  'leaveGroup',
  'verifyIdentity',
  'approveIdentity',
  'updateConversation',
  'syncContactsAndGroups',
] as const satisfies readonly (keyof ChatBackend)[];

async function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const onError = vi.fn();
  const base = { backend, repository, stores, clock: scheduler, onError };
  const requestsRef: { current?: MessageRequestService } = {};
  const identityRef: { current?: IdentityService } = {};
  const sync = new SyncService({
    ...base,
    scheduler,
    onRequestAnswered: (e) => requestsRef.current!.applySynced(e),
    onVerificationSynced: (e) => identityRef.current!.applySynced(e),
  });
  await sync.start();
  requestsRef.current = new MessageRequestService({ ...base, sync });
  identityRef.current = new IdentityService(base);
  const dm = backend.world.conversationIds.get('request-dm')!;
  const group = backend.world.conversationIds.get('request-group')!;
  const selfId = backend.world.self.id;
  const peer = backend.world.conversations.get(dm)!.memberIds.find((m) => m !== selfId)!;
  const spies = OUTGOING.map((name) => vi.spyOn(backend, name));
  const trustRead = vi.spyOn(backend, 'getSafetyNumber');
  const lines = async (id: ConversationId) =>
    (await repository.listAfter(id, 0)).filter((m) => m.kind === 'system');
  return {
    scheduler,
    backend,
    repository,
    stores,
    sync,
    requests: requestsRef.current,
    identity: identityRef.current,
    onError,
    dm,
    group,
    peer,
    selfId,
    spies,
    /** What signal-cli reports as this person's trust (it applies a matching sync itself). */
    backendSays(trust: IdentityTrust) {
      trustRead.mockResolvedValue({ digits: '1', qr: [1], trust });
    },
    /** A new process over the same persisted state: fresh services, nothing remembered in memory. */
    restart() {
      requestsRef.current = new MessageRequestService({ ...base, sync });
      identityRef.current = new IdentityService(base);
    },
    lines,
    state: (id: ConversationId) => selectMessageRequestState(stores, id),
    /** Delivers what the phone says and waits for it to be applied. */
    async answer(
      id: ConversationId,
      answer: Parameters<typeof backend.emit<'messageRequestResponse'>>[1]['answer'],
      at = AT,
    ) {
      backend.emit('messageRequestResponse', { conversationId: id, answer, at });
      await sync.idle();
    },
    async verified(verified: boolean, at = AT) {
      backend.emit('identityVerified', { contactId: peer, verified, at });
      await sync.idle();
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const nothingSent = (t: Setup) => {
  for (const spy of t.spies) expect(spy).not.toHaveBeenCalled();
  expect(t.backend.requestResponses).toEqual([]);
  expect(t.onError).not.toHaveBeenCalled();
};
/** The lines the user's own answers write (a group's history has other system lines). */
const texts = async (t: Setup, id: ConversationId) =>
  (await t.lines(id)).filter((m) => m.authorId === t.selfId).map((m) => m.systemText);

describe('a message request answered on the phone', () => {
  it('accept: the chat becomes accepted, with the same line as answering here, previewless, and nothing is sent', async () => {
    const t = await setup();
    const name = t.stores.contacts.getState().byId[t.peer]!.name;
    expect(t.state(t.dm)).toBe('request');
    await t.answer(t.dm, 'accept');
    expect(t.state(t.dm)).toBe('accepted');
    expect(t.stores.local.getState().acceptedChats[t.dm]).toBe(AT);
    const lines = await t.lines(t.dm);
    expect(lines.map((m) => m.systemText)).toEqual([`You accepted ${name}'s message request`]);
    expect(lines[0]?.previewless).toBe(true);
    nothingSent(t);
  });

  it('accept: a group request is answered by its group id', async () => {
    const t = await setup();
    await t.answer(t.group, 'accept');
    expect(t.state(t.group)).toBe('accepted');
    expect(await texts(t, t.group)).toEqual(['You accepted the message request']);
    nothingSent(t);
  });

  it('unblock and accept: unblocks and accepts a blocked chat, saying so as Desktop does', async () => {
    const t = await setup();
    await t.answer(t.dm, 'block', AT - 10);
    expect(t.state(t.dm)).toBe('blocked');
    await t.answer(t.dm, 'unblockAndAccept');
    expect(t.state(t.dm)).toBe('accepted');
    expect(t.stores.contacts.getState().byId[t.peer]?.blocked).toBeUndefined();
    expect(await texts(t, t.dm)).toEqual(['You blocked this person', 'You unblocked this person']);
    nothingSent(t);
  });

  it('block: the chat stays, shown as blocked, and nothing is sent', async () => {
    const t = await setup();
    await t.answer(t.dm, 'block');
    expect(t.state(t.dm)).toBe('blocked');
    expect(t.stores.conversations.getState().byId[t.dm]).toBeDefined();
    expect(await texts(t, t.dm)).toEqual(['You blocked this person']);
    nothingSent(t);
  });

  it('block: a group is blocked but not left (leaving would tell the group)', async () => {
    const t = await setup();
    await t.answer(t.group, 'block');
    expect(t.stores.conversations.getState().byId[t.group]?.blocked).toBe(true);
    expect(t.stores.conversations.getState().byId[t.group]?.left).toBeUndefined();
    expect(await texts(t, t.group)).toEqual(['You blocked the group']);
    nothingSent(t);
  });

  it('delete: the chat and its stored messages go, and it stays hidden, with nothing sent', async () => {
    const t = await setup();
    expect(await t.repository.count(t.dm)).toBeGreaterThan(0);
    await t.answer(t.dm, 'delete');
    expect(t.stores.conversations.getState().byId[t.dm]).toBeUndefined();
    expect(await t.repository.count(t.dm)).toBe(0);
    expect(t.stores.local.getState().deletedChats[t.dm]).toBe(AT);
    nothingSent(t);
  });

  it('delete: a chat with something newer than the answer is kept (a replay after a fresh request)', async () => {
    const t = await setup();
    await t.answer(t.dm, 'delete', 1);
    expect(t.stores.conversations.getState().byId[t.dm]).toBeDefined();
    expect(await t.repository.count(t.dm)).toBeGreaterThan(0);
  });

  it('block and delete: blocked and gone', async () => {
    const t = await setup();
    await t.answer(t.dm, 'blockAndDelete');
    expect(t.stores.contacts.getState().byId[t.peer]?.blocked).toBe(true);
    expect(t.stores.conversations.getState().byId[t.dm]).toBeUndefined();
    expect(await t.repository.count(t.dm)).toBe(0);
    nothingSent(t);
  });

  it('spam: "Reported as spam", and the chat is neither blocked nor accepted', async () => {
    const t = await setup();
    await t.answer(t.dm, 'spam');
    expect(t.state(t.dm)).toBe('request');
    expect(await texts(t, t.dm)).toEqual(['Reported as spam']);
    nothingSent(t);
  });

  it('block and spam: blocked, with both lines', async () => {
    const t = await setup();
    await t.answer(t.dm, 'blockAndSpam');
    expect(t.state(t.dm)).toBe('blocked');
    expect((await texts(t, t.dm)).sort()).toEqual(['Reported as spam', 'You blocked this person']);
    nothingSent(t);
  });

  it('ignores an answer about a chat it does not know', async () => {
    const t = await setup();
    await t.answer(directConversationId('nobody'), 'accept');
    expect(t.stores.local.getState().acceptedChats[directConversationId('nobody')]).toBeUndefined();
    nothingSent(t);
  });

  it.each(['accept', 'block', 'spam', 'blockAndSpam'] as const)(
    'replaying %s changes nothing and writes no second line',
    async (answer) => {
      const t = await setup();
      await t.answer(t.dm, answer);
      const before = (await t.lines(t.dm)).map((m) => m.id);
      const state = t.state(t.dm);
      expect(before.length).toBeGreaterThan(0);
      await t.answer(t.dm, answer);
      expect((await t.lines(t.dm)).map((m) => m.id)).toEqual(before);
      expect(t.state(t.dm)).toBe(state);
      nothingSent(t);
    },
  );

  it('a replayed answer cannot undo a newer one made here', async () => {
    const t = await setup();
    await t.answer(t.dm, 'block');
    // The user unblocks here a little later than the phone's block.
    t.scheduler.advance(120_000);
    await t.requests.unblock(t.dm);
    expect(t.state(t.dm)).toBe('accepted');
    t.backend.emit('messageRequestResponse', { conversationId: t.dm, answer: 'block', at: AT });
    await t.sync.idle();
    expect(t.state(t.dm)).toBe('accepted');
  });

  it('a replayed accept cannot undo a block that came after it', async () => {
    const t = await setup();
    await t.answer(t.dm, 'accept', AT);
    await t.answer(t.dm, 'block', AT + 5);
    await t.answer(t.dm, 'accept', AT);
    expect(t.state(t.dm)).toBe('blocked');
  });
});

describe('an own message processed before a phone answer that came after it', () => {
  it('stamps the accept with the message time, so the later synced block still applies', async () => {
    const t = await setup();
    const sentAt = AT - 20_000;
    // Processed late (a backlog replay), long after it was sent.
    t.scheduler.advance(10 * 60_000);
    acceptForOutgoing(t.stores, [
      makeMessage({ conversationId: t.dm, authorId: t.selfId, sentAt: sentAt + 5 }),
      makeMessage({ conversationId: t.dm, authorId: t.selfId, sentAt }),
    ]);
    expect(t.stores.local.getState().acceptedChats[t.dm]).toBe(sentAt);
    await t.answer(t.dm, 'block', AT);
    expect(t.state(t.dm)).toBe('blocked');
    expect(await texts(t, t.dm)).toEqual(['You blocked this person']);
  });
});

describe('answers replayed after a restart', () => {
  const restartAfter = async (t: Setup, local: () => Promise<unknown>) => {
    // The user acts here a while after the phone's answer, then the app restarts.
    t.scheduler.advance(120_000);
    await local();
    t.restart();
  };

  it('an old accept does not bring back a chat deleted here since', async () => {
    const t = await setup();
    await t.answer(t.dm, 'accept');
    await restartAfter(t, () => t.requests.remove(t.dm));
    await t.answer(t.dm, 'accept');
    expect(t.stores.local.getState().deletedChats[t.dm]).toBeDefined();
    expect(t.stores.local.getState().acceptedChats[t.dm]).toBeUndefined();
    expect(t.stores.conversations.getState().byId[t.dm]).toBeUndefined();
  });

  it('an old accept does not unblock a chat blocked here since', async () => {
    const t = await setup();
    await t.answer(t.dm, 'accept');
    await restartAfter(t, () => t.requests.block(t.dm));
    await t.answer(t.dm, 'accept');
    expect(t.state(t.dm)).toBe('blocked');
  });

  it('an old unblock-and-accept does not unblock a chat blocked here since, even if it was accepted before', async () => {
    const t = await setup();
    await t.requests.accept(t.dm);
    t.scheduler.advance(30_000);
    await t.requests.block(t.dm);
    await t.answer(t.dm, 'unblockAndAccept', AT);
    expect(t.state(t.dm)).toBe('accepted');
    await restartAfter(t, () => t.requests.block(t.dm));
    await t.answer(t.dm, 'unblockAndAccept', AT);
    expect(t.state(t.dm)).toBe('blocked');
  });

  it('an old block does not re-block a chat unblocked here since', async () => {
    const t = await setup();
    await t.answer(t.dm, 'block');
    await restartAfter(t, () => t.requests.unblock(t.dm));
    await t.answer(t.dm, 'block');
    expect(t.state(t.dm)).toBe('accepted');
  });

  it('an old block does not re-block a chat the phone then accepted, even in a new session', async () => {
    const t = await setup();
    await t.answer(t.dm, 'block', AT);
    await t.answer(t.dm, 'unblockAndAccept', AT + 5);
    t.restart();
    await t.answer(t.dm, 'block', AT);
    expect(t.state(t.dm)).toBe('accepted');
  });

  it('an old delete does not delete a chat accepted here since', async () => {
    const control = await setup();
    // Without the accept the same answer does delete, so the guard below is the accept stamp.
    await control.answer(control.dm, 'delete', NOW);
    expect(control.stores.conversations.getState().byId[control.dm]).toBeUndefined();
    const t = await setup();
    await t.requests.accept(t.dm);
    t.restart();
    await t.answer(t.dm, 'delete', NOW);
    expect(t.stores.conversations.getState().byId[t.dm]).toBeDefined();
    expect(await t.repository.count(t.dm)).toBeGreaterThan(0);
  });

  it('an old block-and-delete does not delete a chat accepted here since', async () => {
    const t = await setup();
    await t.requests.accept(t.dm);
    await t.answer(t.dm, 'blockAndDelete', NOW);
    expect(t.stores.conversations.getState().byId[t.dm]).toBeDefined();
    expect(t.state(t.dm)).toBe('accepted');
  });

  it('a delete replayed after the chat was deleted does nothing more', async () => {
    const t = await setup();
    await t.answer(t.dm, 'delete');
    t.restart();
    await t.answer(t.dm, 'delete');
    expect(t.stores.local.getState().deletedChats[t.dm]).toBe(AT);
    nothingSent(t);
  });
});

describe('who an answer is about', () => {
  it('finds a chat stored under the number when the ACI is not known here', async () => {
    const t = await setup();
    const unknownAci = directConversationId('aci-nobody-here-has');
    await t.answer(unknownAci, 'spam');
    expect(await texts(t, t.dm)).toEqual([]);
    t.backend.emit('messageRequestResponse', {
      conversationId: unknownAci,
      alsoKnownAs: t.dm,
      answer: 'spam',
      at: AT,
    });
    await t.sync.idle();
    expect(await texts(t, t.dm)).toEqual(['Reported as spam']);
  });
});

describe('Reported as spam', () => {
  it('is written once per report, however many times that sync is replayed', async () => {
    const t = await setup();
    await t.answer(t.dm, 'spam', AT);
    await t.answer(t.dm, 'spam', AT);
    await t.answer(t.dm, 'blockAndSpam', AT);
    t.restart();
    await t.answer(t.dm, 'spam', AT);
    expect((await texts(t, t.dm)).filter((x) => x === 'Reported as spam')).toHaveLength(1);
  });

  it('finds an earlier report by its line, without reading the chat', async () => {
    const t = await setup();
    await t.answer(t.dm, 'spam', AT);
    const list = vi.spyOn(t.repository, 'listAfter');
    t.restart();
    await t.answer(t.dm, 'spam', AT);
    expect(list).not.toHaveBeenCalled();
    expect((await texts(t, t.dm)).filter((x) => x === 'Reported as spam')).toHaveLength(1);
  });
});

describe('a safety number marked on the phone', () => {
  const name = (t: Setup) => t.stores.contacts.getState().byId[t.peer]!.name;
  const verifiedLine = (t: Setup) =>
    `You marked your Safety Number with ${name(t)} as verified from another device`;
  const notVerifiedLine = (t: Setup) =>
    `You marked your Safety Number with ${name(t)} as not verified from another device`;

  it('verified: the badge follows and the "from another device" line is written, with nothing sent', async () => {
    const t = await setup();
    t.backendSays('verified');
    await t.verified(true);
    expect(t.stores.identities.getState().trustById[t.peer]).toBe('verified');
    expect(await texts(t, t.dm)).toEqual([verifiedLine(t)]);
    nothingSent(t);
  });

  it('not verified after verified: no longer verified, and says so', async () => {
    const t = await setup();
    t.backendSays('verified');
    await t.verified(true, AT);
    t.backendSays('default');
    await t.verified(false, AT + 5);
    expect(t.stores.identities.getState().trustById[t.peer]).toBe('default');
    expect(await texts(t, t.dm)).toEqual([verifiedLine(t), notVerifiedLine(t)]);
    nothingSent(t);
  });

  it('not verified for someone never verified here: no line, and no guess cached', async () => {
    const t = await setup();
    // Nothing in the cache; the backend's own answer is what the badge then shows.
    const reads = vi.spyOn(t.backend, 'getSafetyNumber').mockResolvedValue(null);
    await t.verified(false);
    expect(await texts(t, t.dm)).toEqual([]);
    expect(t.stores.identities.getState().trustById[t.peer]).toBeNull();
    expect(reads).toHaveBeenCalledWith(t.peer);
    nothingSent(t);
  });

  it('the badge shows the backend’s real trust, not the sync’s claim', async () => {
    const t = await setup();
    // signal-cli did not apply it (its key differs): the badge must not claim verified.
    t.backendSays('default');
    await t.verified(true);
    expect(t.stores.identities.getState().trustById[t.peer]).toBe('default');
  });

  it('a replay changes nothing and writes no second line, even in a fresh session', async () => {
    const t = await setup();
    t.backendSays('verified');
    await t.verified(true);
    const before = (await t.lines(t.dm)).map((m) => m.id);
    await t.verified(true);
    expect((await t.lines(t.dm)).map((m) => m.id)).toEqual(before);
    // A restart forgets the cached trust; the user has since cleared the verification here.
    t.restart();
    t.stores.identities.getState().setTrust(t.peer, null);
    t.backendSays('default');
    await t.verified(true);
    expect((await t.lines(t.dm)).map((m) => m.id)).toEqual(before);
    expect(t.stores.identities.getState().trustById[t.peer]).toBe('default');
  });

  it('verified over a key that changed is not applied: stays untrusted, no line', async () => {
    const t = await setup();
    t.stores.identities.getState().setTrust(t.peer, 'untrusted');
    t.backendSays('untrusted');
    await t.verified(true);
    expect(t.stores.identities.getState().trustById[t.peer]).toBe('untrusted');
    expect(await texts(t, t.dm)).toEqual([]);
    nothingSent(t);
  });

  it('a key that changed since stays untrusted when the phone says not verified', async () => {
    const t = await setup();
    t.stores.identities.getState().setTrust(t.peer, 'untrusted');
    t.backendSays('untrusted');
    await t.verified(false);
    expect(t.stores.identities.getState().trustById[t.peer]).toBe('untrusted');
  });
});
