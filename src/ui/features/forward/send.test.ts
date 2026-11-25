import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { directConversationId, MAX_ATTACHMENT_BYTES, type Contact } from '@/core/domain';
import { selectConversationViews } from '@/core/stores';
import { bootForward, openChat, ownMessages, type ForwardKit } from '@/test/forwardKit';
import { buildForwardTargets, type ForwardTarget } from './model';
import { forwardToTarget, forwardToTargets, type ForwardItem } from './send';

let kit: ForwardKit;
const live: Snowdrop[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
});
beforeEach(async () => {
  kit = await bootForward();
  live.push(kit.snowdrop);
});

/** Every chat as the dialog would list it, by demo key. */
function target(key: string): ForwardTarget {
  const { stores } = kit.snowdrop;
  const id = kit.chat(key);
  const found = buildForwardTargets({
    views: selectConversationViews(
      stores.conversations.getState().byId,
      stores.local.getState().conversations,
    ),
    contacts: stores.contacts.getState().byId,
    composable: [],
    self: stores.session.getState().self,
    requestState: () => 'accepted',
  }).find((t) => t.id === id);
  if (!found) throw new Error(`no chat ${key}`);
  return found;
}

const sentInputs = () => {
  const spy = vi.spyOn(kit.mock, 'send');
  return () => spy.mock.calls.map(([input]) => input);
};

const text = (value: string): ForwardItem => ({ kind: 'message', text: value, files: [] });

describe('forwardToTarget re-checks the chat at send', () => {
  it('skips a group that was left after it was picked, sending nothing into it', async () => {
    await openChat(kit.snowdrop, kit.chat('crux'));
    const picked = target('crux');
    expect(picked.unavailable).toBeUndefined();
    const { conversations } = kit.snowdrop.stores;
    conversations.getState().upsert({ ...conversations.getState().byId[picked.id]!, left: true });
    const inputs = sentInputs();
    const result = await forwardToTarget(kit.snowdrop, picked, [text('into a left group')]);
    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      reason: 'You left this group.',
      sent: 0,
    });
    expect(inputs()).toEqual([]);
  });

  it('skips a chat that was blocked after it was picked', async () => {
    const picked = target('dm-ines');
    const peer = picked.contact!;
    const { contacts } = kit.snowdrop.stores;
    contacts.setState((s) => ({ byId: { ...s.byId, [peer.id]: { ...peer, blocked: true } } }));
    const inputs = sentInputs();
    const result = await forwardToTarget(kit.snowdrop, picked, [text('to a blocked chat')]);
    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'Blocked.' });
    expect(inputs()).toEqual([]);
  });
});

describe('forwardToTarget', () => {
  it('sends one ordinary message per chat, in order, as markdown text (no quote)', async () => {
    await openChat(kit.snowdrop, kit.chat('dm-ines'));
    const inputs = sentInputs();
    const result = await forwardToTarget(kit.snowdrop, target('dm-ines'), [
      text('first **bold**'),
      text('second'),
    ]);
    expect(result).toEqual({ id: kit.chat('dm-ines'), ok: true, sent: 2, delivered: ['#0', '#1'] });
    const sent = inputs();
    expect(sent.map((s) => s.body)).toEqual(['first bold', 'second']);
    expect(sent[0]?.ranges).toEqual([{ start: 6, length: 4, style: 'bold' }]);
    expect(sent.every((s) => s.conversationId === kit.chat('dm-ines') && !s.quote)).toBe(true);
    // They are normal messages of the user's own, in that chat.
    expect(
      ownMessages(kit.snowdrop, kit.chat('dm-ines'))
        .slice(-2)
        .map((m) => m.body),
    ).toEqual(['first bold', 'second']);
  });

  it('follows the markdown text even when the user has markdown turned off', async () => {
    kit.snowdrop.stores.settings.getState().update('behaviour', { markdown: false });
    const inputs = sentInputs();
    await forwardToTarget(kit.snowdrop, target('dm-ines'), [text('a **b**')]);
    expect(inputs()[0]?.body).toBe('a b');
  });

  it('re-sends files from their bytes, keeping the voice flag, size and type', async () => {
    const inputs = sentInputs();
    const voice = new Blob(['voice-bytes'], { type: 'audio/aac' });
    await forwardToTarget(kit.snowdrop, target('dm-ines'), [
      {
        kind: 'message',
        text: '',
        files: [
          { fileName: 'voice-message', contentType: 'audio/aac', data: voice, voiceNote: true },
        ],
      },
      {
        kind: 'message',
        text: 'photo',
        files: [
          {
            fileName: 'a.png',
            contentType: 'image/png',
            data: new Blob(['p']),
            width: 3,
            height: 2,
          },
        ],
      },
    ]);
    const [first, second] = inputs();
    expect(first?.attachments).toMatchObject([
      { fileName: 'voice-message', contentType: 'audio/aac', voiceNote: true },
    ]);
    expect(first?.attachments?.[0]?.data).toBe(voice);
    expect(second?.attachments).toMatchObject([
      { fileName: 'a.png', contentType: 'image/png', width: 3, height: 2 },
    ]);
    expect(second?.attachments?.[0]?.voiceNote).toBeUndefined();
  });

  it('names a file that is too large and sends nothing', async () => {
    const huge = new Blob(['x']);
    Object.defineProperty(huge, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    const inputs = sentInputs();
    const result = await forwardToTarget(kit.snowdrop, target('dm-ines'), [
      {
        kind: 'message',
        text: '',
        files: [{ fileName: 'big.bin', contentType: 'x/y', data: huge }],
      },
    ]);
    expect(result).toMatchObject({
      ok: false,
      reason: '\u201cbig.bin\u201d is over 100 MB, so it can\u2019t be sent.',
      sent: 0,
    });
    expect(inputs()).toEqual([]);
  });

  it('sends a sticker as a sticker, and the link preview with its picture', async () => {
    const inputs = sentInputs();
    await forwardToTarget(kit.snowdrop, target('dm-ines'), [
      { kind: 'sticker', sticker: { packId: 'ab', stickerId: 3, emoji: '🙌', url: 'x' } },
      {
        kind: 'message',
        text: 'https://example.org',
        files: [],
        preview: {
          url: 'https://example.org',
          title: 'Example',
          image: { contentType: 'image/png', data: new Blob(['i']), width: 4, height: 4 },
        },
      },
    ]);
    const [sticker, link] = inputs();
    expect(sticker?.sticker).toMatchObject({ packId: 'ab', stickerId: 3 });
    expect(sticker?.body).toBe('');
    expect(link?.preview).toMatchObject({ url: 'https://example.org', title: 'Example' });
    expect(link?.preview?.image?.data.size).toBe(1);
  });

  it('shows a send that the network refuses as a failed message in that chat, ready to retry', async () => {
    const id = kit.chat('dm-ines');
    await openChat(kit.snowdrop, id);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    kit.mock.failNext();
    const result = await forwardToTarget(kit.snowdrop, target('dm-ines'), [text('hello')]);
    expect(result.ok).toBe(true);
    const own = ownMessages(kit.snowdrop, id).at(-1);
    expect(own).toMatchObject({ body: 'hello', status: 'failed' });
    // Retry is the ordinary one: it sends this same message again.
    await kit.snowdrop.send.retry(id, own!.nonce!);
    expect(ownMessages(kit.snowdrop, id).at(-1)?.status).not.toBe('failed');
  });

  it('keeps the chats apart: one failing does not stop the others', async () => {
    const real = kit.snowdrop.send.send.bind(kit.snowdrop.send);
    vi.spyOn(kit.snowdrop.send, 'send').mockImplementation((draft) => {
      if (draft.conversationId === kit.chat('dm-ines'))
        return Promise.reject(new Error('disk full'));
      return real(draft);
    });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const results = await forwardToTargets(
      kit.snowdrop,
      [target('dm-ines'), target('dm-lucia')],
      [text('hi')],
    );
    expect(results).toEqual([
      {
        id: kit.chat('dm-ines'),
        ok: false,
        reason: "Couldn't send.",
        sent: 0,
        delivered: [],
      },
      { id: kit.chat('dm-lucia'), ok: true, sent: 1, delivered: ['#0'] },
    ]);
    // The reason names no one and says nothing of the content.
    expect(JSON.stringify(log.mock.calls)).not.toContain('disk full');
    expect(JSON.stringify(log.mock.calls)).not.toContain('hi');
  });

  it('counts what went through when a later message fails, and a retry sends only the rest', async () => {
    const id = kit.chat('dm-ines');
    await openChat(kit.snowdrop, id);
    const real = kit.snowdrop.send.send.bind(kit.snowdrop.send);
    let calls = 0;
    vi.spyOn(kit.snowdrop.send, 'send').mockImplementation((draft) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('offline')) : real(draft);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const items = [text('one'), text('two'), text('three')];
    const first = await forwardToTarget(kit.snowdrop, target('dm-ines'), items);
    expect(first).toEqual({
      id,
      ok: false,
      reason: "Couldn't send.",
      sent: 1,
      delivered: ['#0'],
    });
    const retry = await forwardToTarget(
      kit.snowdrop,
      target('dm-ines'),
      items,
      new Set(first.delivered),
    );
    expect(retry).toMatchObject({ id, ok: true, sent: 3 });
    expect(
      ownMessages(kit.snowdrop, id)
        .map((m) => m.body)
        .slice(-3),
    ).toEqual(['one', 'two', 'three']);
  });

  it('skips by item identity, so a retry after the list shrank sends the right ones', async () => {
    const id = kit.chat('dm-ines');
    await openChat(kit.snowdrop, id);
    const real = kit.snowdrop.send.send.bind(kit.snowdrop.send);
    vi.spyOn(kit.snowdrop.send, 'send').mockImplementationOnce(real);
    vi.spyOn(kit.snowdrop.send, 'send').mockImplementationOnce(() =>
      Promise.reject(new Error('x')),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const item = (key: string): ForwardItem => ({ ...text(key), id: key });
    const first = await forwardToTarget(kit.snowdrop, target('dm-ines'), [
      item('a'),
      item('b'),
      item('c'),
    ]);
    expect(first.delivered).toEqual(['a']);
    vi.restoreAllMocks();
    const inputs = sentInputs();
    // "a" was taken out of the list: "b" and "c" are still owed.
    const retry = await forwardToTarget(
      kit.snowdrop,
      target('dm-ines'),
      [item('b'), item('c')],
      new Set(first.delivered),
    );
    expect(retry).toMatchObject({ ok: true, sent: 2 });
    expect(inputs().map((i) => i.body)).toEqual(['b', 'c']);
  });

  it('takes per-chat progress for a retry of several chats', async () => {
    const id = kit.chat('dm-ines');
    await openChat(kit.snowdrop, id);
    const inputs = sentInputs();
    const results = await forwardToTargets(
      kit.snowdrop,
      [target('dm-ines')],
      [text('one'), text('two')],
      new Map([[id, new Set(['#0'])]]),
    );
    expect(results).toMatchObject([{ id, ok: true, sent: 2 }]);
    expect(inputs().map((i) => i.body)).toEqual(['two']);
  });

  it('reports a send that turned into nothing', async () => {
    vi.spyOn(kit.snowdrop.send, 'send').mockResolvedValue(null);
    expect(await forwardToTarget(kit.snowdrop, target('dm-ines'), [text('x')])).toEqual({
      id: kit.chat('dm-ines'),
      ok: false,
      reason: 'There was nothing to send.',
      sent: 0,
      delivered: [],
    });
  });

  it('starts a chat with a contact that has none, without opening it', async () => {
    const { stores } = kit.snowdrop;
    const friend: Contact = { id: 'new-friend', name: 'New Friend', color: '#123' };
    stores.contacts.getState().upsert(friend);
    const id = directConversationId(friend.id);
    expect(stores.conversations.getState().byId[id]).toBeUndefined();
    const before = stores.ui.getState().selectedConversationBySpace;
    const inputs = sentInputs();
    const result = await forwardToTarget(
      kit.snowdrop,
      {
        id,
        title: friend.name,
        kind: 'direct',
        contact: friend,
        meta: 'Contact',
        request: false,
        archived: false,
      },
      [text('welcome')],
    );
    expect(result).toEqual({ id, ok: true, sent: 1, delivered: ['#0'] });
    expect(stores.conversations.getState().byId[id]?.title).toBe('New Friend');
    expect(stores.ui.getState().selectedConversationBySpace).toEqual(before);
    expect(inputs()[0]).toMatchObject({ conversationId: id, body: 'welcome' });
  });

  it('accepts a message request first, the way answering it does, then sends', async () => {
    const id = kit.chat('request-dm');
    const respond = vi.spyOn(kit.mock, 'respondToMessageRequest');
    const sendSpy = vi.spyOn(kit.mock, 'send');
    const inputs = () => sendSpy.mock.calls.map(([input]) => input);
    const result = await forwardToTarget(kit.snowdrop, target('request-dm'), [text('hello')]);
    expect(result).toEqual({ id, ok: true, sent: 1, delivered: ['#0'] });
    expect(respond).toHaveBeenCalledWith(id, 'accept');
    expect(respond.mock.invocationCallOrder[0]).toBeLessThan(sendSpy.mock.invocationCallOrder[0]!);
    expect(kit.snowdrop.stores.local.getState().acceptedChats[id]).toBeDefined();
    expect(inputs()).toHaveLength(1);
  });

  it('sends nothing into a request it could not accept', async () => {
    const id = kit.chat('request-dm');
    vi.spyOn(kit.snowdrop.requests, 'accept').mockResolvedValue(false);
    const inputs = sentInputs();
    const result = await forwardToTarget(kit.snowdrop, target('request-dm'), [text('hello')]);
    expect(result).toEqual({
      id,
      ok: false,
      reason: "Couldn't accept the message request.",
      sent: 0,
      delivered: [],
    });
    expect(inputs()).toEqual([]);
    expect(kit.snowdrop.stores.local.getState().acceptedChats[id]).toBeUndefined();
  });

  it('jumps a chat back to the present first, so the sent message shows', async () => {
    const id = kit.chat('dm-ines');
    await openChat(kit.snowdrop, id);
    kit.snowdrop.stores.messages.setState((s) => ({
      windows: { ...s.windows, [id]: { ...s.windows[id]!, anchoredToPresent: false } },
    }));
    const jump = vi.spyOn(kit.snowdrop.history, 'jumpToPresent');
    await forwardToTarget(kit.snowdrop, target('dm-ines'), [text('here')]);
    expect(jump).toHaveBeenCalledWith(id);
  });
});
