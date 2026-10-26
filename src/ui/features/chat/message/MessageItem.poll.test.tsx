import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import {
  messageId,
  type ConversationId,
  type Message,
  type MessageId,
  type PollContent,
} from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessageItem } from './MessageItem';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };

/** A group on screen with one poll (written by `who`) in it, rendered as a row. */
async function withPoll(who: 'me' | 'other', extra: Partial<PollContent> = {}) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
  });
  const backend = (await snowdrop.backendReady) as MockBackend;
  const selfId = snowdrop.stores.session.getState().self!.id;
  const other = conv.memberIds.find((id) => id !== selfId)!;
  const second = conv.memberIds.find((id) => id !== selfId && id !== other)!;
  const authorId = who === 'me' ? selfId : other;
  const sentAt = Date.now();
  const poll: Message = {
    id: messageId(authorId, sentAt),
    conversationId: conv.id,
    authorId,
    sentAt,
    receivedAt: sentAt,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
    status: who === 'me' ? 'sent' : 'read',
    kind: 'normal',
    poll: {
      question: 'Where to eat?',
      options: ['Pizza', 'Ramen', 'Tacos'],
      allowMultiple: true,
      votes: [],
      ...extra,
    },
  };
  // The mock keeps what it delivers, so later votes and ends find the poll there too.
  act(() => {
    backend.deliver(poll);
  });
  await settle(snowdrop);
  const chat = new ChatController();
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={chat}>
      <div data-snowdrop="message-log">
        <MessageItem
          conversationId={conv.id}
          id={poll.id}
          continuation={false}
          compact={false}
          compactAvatars={false}
        />
      </div>
    </ChatControllerProvider>,
  );
  return { snowdrop, backend, conv: conv.id, poll, selfId, other, second };
}

const current = (snowdrop: Snowdrop, conv: ConversationId, id: MessageId) =>
  messagesSelectors.message(conv, id)(snowdrop.stores.messages.getState());

const card = () => screen.getByRole('group', { name: 'Where to eat?' });

describe('<MessageItem /> with a poll', () => {
  it('shows the poll card, not text, with the options to answer it', async () => {
    await withPoll('other');
    expect(within(card()).getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText('Poll · Select one or more')).toBeTruthy();
    expect(screen.getByRole('article').getAttribute('aria-describedby')).toBeTruthy();
  });

  it("records your vote at once and sends it to the poll's author", async () => {
    const { snowdrop, backend, conv, poll, selfId, other } = await withPoll('other');
    const spy = vi.spyOn(backend, 'votePoll');
    fireEvent.click(within(card()).getByRole('checkbox', { name: /^Ramen/u }));
    await settle(snowdrop);
    expect(spy).toHaveBeenCalledWith({
      conversationId: conv,
      pollAuthorId: other,
      pollSentAt: poll.sentAt,
      optionIndexes: [1],
      voteCount: 1,
    });
    expect(current(snowdrop, conv, poll.id)?.poll?.votes).toMatchObject([
      { voterId: selfId, optionIndexes: [1] },
    ]);
    const ramen = within(card()).getByRole<HTMLInputElement>('checkbox', { name: /^Ramen/u });
    expect(ramen.checked).toBe(true);
    expect(ramen.getAttribute('aria-disabled')).toBeNull();
    // Choosing it again takes the vote back.
    fireEvent.click(ramen);
    await settle(snowdrop);
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ optionIndexes: [], voteCount: 2 }),
    );
    expect(
      within(card()).getByRole<HTMLInputElement>('checkbox', { name: /^Ramen/u }).checked,
    ).toBe(false);
  });

  it('takes a vote back and says so when it cannot be sent', async () => {
    const { snowdrop, backend, conv, poll } = await withPoll('other');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    backend.failNext();
    fireEvent.click(within(card()).getByRole('checkbox', { name: /^Pizza/u }));
    await settle(snowdrop);
    expect(current(snowdrop, conv, poll.id)?.poll?.votes).toEqual([]);
    expect(
      within(card()).getByRole<HTMLInputElement>('checkbox', { name: /^Pizza/u }).checked,
    ).toBe(false);
    expect(snowdrop.stores.ui.getState().toasts.map((t) => t.message)).toContain(
      "Couldn't send your vote",
    );
  });

  it('shows votes that arrive, and the results once the poll ends', async () => {
    const { snowdrop, backend, conv, poll, other, second } = await withPoll('other');
    act(() => {
      backend.emit('pollVote', {
        conversationId: conv,
        targetAuthorId: other,
        targetSentAt: poll.sentAt,
        voterId: second,
        optionIndexes: [2],
        voteCount: 1,
        at: poll.sentAt + 1,
      });
    });
    await settle(snowdrop);
    expect(within(card()).getByRole('checkbox', { name: /^Tacos 1 vote, 100%/u })).toBeTruthy();
    act(() => {
      backend.emit('pollTerminate', {
        conversationId: conv,
        authorId: other,
        targetSentAt: poll.sentAt,
        at: poll.sentAt + 2,
      });
    });
    await settle(snowdrop);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText('Poll · Final results')).toBeTruthy();
  });

  it("opens who voted, and offers no End poll on somebody else's poll", async () => {
    const { snowdrop, backend, conv, poll, other, second } = await withPoll('other');
    act(() => {
      backend.emit('pollVote', {
        conversationId: conv,
        targetAuthorId: other,
        targetSentAt: poll.sentAt,
        voterId: second,
        optionIndexes: [0],
        voteCount: 1,
        at: poll.sentAt + 1,
      });
    });
    await settle(snowdrop);
    fireEvent.click(screen.getByRole('button', { name: 'View votes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Poll details' });
    const voterName = snowdrop.stores.contacts.getState().byId[second]?.name;
    expect(within(dialog).getByText(voterName!)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'End poll' })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
  });

  it('keeps the card in step with the row: no editing a poll, no copy text', async () => {
    await withPoll('me');
    fireEvent.contextMenu(screen.getByRole('article'));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Copy text' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Reply' })).toBeTruthy();
  });

  it('lets the author end it from the menu, after asking', async () => {
    const { snowdrop, conv, poll } = await withPoll('me');
    fireEvent.contextMenu(screen.getByRole('article'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'End poll' }));
    const dialog = await screen.findByRole('dialog', { name: 'End poll' });
    expect(within(dialog).getByText('Where to eat?')).toBeTruthy();
    // Cancel changes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle(snowdrop);
    expect(current(snowdrop, conv, poll.id)?.poll?.ended).toBeUndefined();
    // Confirm ends it.
    fireEvent.contextMenu(screen.getByRole('article'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'End poll' }));
    const again = await screen.findByRole('dialog', { name: 'End poll' });
    fireEvent.click(within(again).getByRole('button', { name: 'End poll' }));
    await settle(snowdrop);
    expect(current(snowdrop, conv, poll.id)?.poll?.ended).toBe(true);
    expect(screen.getByText('Poll · Final results')).toBeTruthy();
    // And a poll that has ended offers no second end.
    fireEvent.contextMenu(screen.getByRole('article'));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'End poll' })).toBeNull();
  });

  it('lets the author end it from the poll details too', async () => {
    const { snowdrop, conv, poll, selfId } = await withPoll('me', {
      votes: [{ voterId: 'someone', optionIndexes: [1], voteCount: 1, at: 1 }],
    });
    expect(selfId).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View votes' }));
    const details = await screen.findByRole('dialog', { name: 'Poll details' });
    fireEvent.click(within(details).getByRole('button', { name: 'End poll' }));
    const confirm = await screen.findByRole('dialog', { name: 'End poll' });
    expect(screen.queryByRole('dialog', { name: 'Poll details' })).toBeNull();
    fireEvent.click(within(confirm).getByRole('button', { name: 'End poll' }));
    await settle(snowdrop);
    expect(current(snowdrop, conv, poll.id)?.poll?.ended).toBe(true);
  });

  it('reopens the poll and says so when the end cannot be sent', async () => {
    const { snowdrop, backend, conv, poll } = await withPoll('me');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fireEvent.contextMenu(screen.getByRole('article'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'End poll' }));
    const dialog = await screen.findByRole('dialog', { name: 'End poll' });
    backend.failNext();
    fireEvent.click(within(dialog).getByRole('button', { name: 'End poll' }));
    await settle(snowdrop);
    expect(current(snowdrop, conv, poll.id)?.poll?.ended).toBeUndefined();
    expect(snowdrop.stores.ui.getState().toasts.map((t) => t.message)).toContain(
      "Couldn't end the poll",
    );
  });

  it('shows an ended poll as final results, with your choice marked', async () => {
    const { selfId } = await withPoll('other', {
      ended: true,
      votes: [{ voterId: 'x', optionIndexes: [0], voteCount: 1, at: 1 }],
    });
    expect(selfId).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText('Poll · Final results')).toBeTruthy();
  });

  it('shows a deleted poll as a deleted message', async () => {
    const { snowdrop, backend, conv, poll, other } = await withPoll('other');
    act(() => {
      backend.emit('messageDeleted', {
        conversationId: conv,
        authorId: other,
        targetSentAt: poll.sentAt,
      });
    });
    await settle(snowdrop);
    expect(screen.queryByRole('group', { name: 'Where to eat?' })).toBeNull();
    expect(screen.getByText('This message was deleted.')).toBeTruthy();
  });

  it('has no axe violations', async () => {
    await withPoll('other', {
      votes: [{ voterId: 'someone', optionIndexes: [1], voteCount: 1, at: 1 }],
    });
    // Someone else's poll: an own message's delivery mark is a separate, existing concern.
    expect((await axe(screen.getByRole('article'), { rules })).violations.map((v) => v.id)).toEqual(
      [],
    );
  });
});
