import { useState } from 'react';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { ConversationView, Message } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { SearchPanel } from './SearchPanel';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

function Panel({ conversation }: { conversation: ConversationView }) {
  const [query, setQuery] = useState('');
  return (
    <SearchPanel
      conversation={conversation}
      query={query}
      onQueryChange={setQuery}
      onClose={vi.fn()}
    />
  );
}

async function setup(search: (query: string) => Promise<Message[]>) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId)[0]!;
  vi.spyOn(snowdrop.repository, 'search').mockImplementation((query) => search(query));
  const chat = new ChatController();
  const reveal = vi.spyOn(chat, 'reveal').mockResolvedValue(true);
  const view = renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={chat}>
      <Panel conversation={conv as unknown as ConversationView} />
    </ChatControllerProvider>,
  );
  const input = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search messages' });
  const type = (value: string) => {
    fireEvent.change(input, { target: { value } });
  };
  return { snowdrop, conv, view, input, type, reveal };
}

const hit = (body: string) => makeMessage({ authorId: 'ana', body });

describe('<SearchPanel />', () => {
  it('opens the best match on Enter once the results are for what is typed', async () => {
    const meeting = hit('meeting at noon');
    const { input, type, reveal } = await setup(() => Promise.resolve([meeting]));
    type('meeting');
    await screen.findByText('meeting at noon');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(reveal).toHaveBeenCalledWith(expect.anything(), meeting.id, { focus: true });
  });

  it('never opens a result of an earlier query while the new one is still being searched', async () => {
    const meeting = hit('meeting at noon');
    let release!: (r: Message[]) => void;
    const { input, type, reveal } = await setup((query) =>
      query === 'meeting'
        ? Promise.resolve([meeting])
        : new Promise<Message[]>((resolve) => {
            release = resolve;
          }),
    );
    type('meeting');
    await screen.findByText('meeting at noon');

    type('meeting notes');
    // Within the debounce, and again while the new search runs: the old hit must not open.
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(release).toBeTypeOf('function');
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(reveal).not.toHaveBeenCalled();

    // Once the answer for the new text arrives, Enter opens that.
    const notes = hit('meeting notes attached');
    await act(async () => {
      release([notes]);
      await Promise.resolve();
    });
    await screen.findByText('meeting notes attached');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(expect.anything(), notes.id, { focus: true });
  });

  it('does not answer new text with the old query\'s "no match"', async () => {
    const { type } = await setup((query) =>
      query === 'zzz' ? Promise.resolve([]) : new Promise<Message[]>(() => undefined),
    );
    type('zzz');
    await screen.findByText(/No messages match/u);
    type('zzzz');
    expect(screen.queryByText(/No messages match/u)).toBeNull();
  });

  it('follows the store: a message deleted for everyone leaves the results, a new match joins them', async () => {
    const gone = hit('meeting at noon');
    const kept = hit('meeting at three');
    const fresh = hit('meeting at five');
    let found = [kept, gone];
    const { snowdrop, conv, type } = await setup(() => Promise.resolve(found));
    const flags = { hasMoreBefore: false, hasMoreAfter: false };
    snowdrop.stores.messages.getState().replaceWindow(conv.id, [gone, kept], flags);
    type('meeting');
    await screen.findByText('meeting at noon');
    screen.getByText('meeting at three').closest<HTMLElement>('[data-search-result]')?.focus();

    found = [kept];
    act(() => {
      snowdrop.stores.messages.getState().remove(conv.id, gone.id);
    });
    await vi.waitFor(() => {
      expect(screen.queryByText('meeting at noon')).toBeNull();
    });
    expect(screen.getByText('meeting at three')).toBeTruthy();
    // The one being looked at is the same element, not rebuilt.
    expect(document.activeElement).toBe(
      screen.getByText('meeting at three').closest('[data-search-result]'),
    );

    found = [fresh, kept];
    act(() => {
      snowdrop.stores.messages.getState().appendLive({ ...fresh, conversationId: conv.id });
    });
    await screen.findByText('meeting at five');
  });

  it('hands focus to the next result, else the previous, else the field, when the focused result leaves (M15)', async () => {
    const one = makeMessage({ authorId: 'ana', sentAt: 1, body: 'meeting one' });
    const two = makeMessage({ authorId: 'ana', sentAt: 2, body: 'meeting two' });
    const three = makeMessage({ authorId: 'ana', sentAt: 3, body: 'meeting three' });
    let found = [one, two, three];
    const { snowdrop, conv, input, type } = await setup(() => Promise.resolve(found));
    snowdrop.stores.messages
      .getState()
      .replaceWindow(conv.id, [one, two, three], { hasMoreBefore: false, hasMoreAfter: false });
    type('meeting');
    await screen.findByText('meeting two');
    const row = (text: string) =>
      screen.getByText(text).closest<HTMLElement>('[data-search-result]')!;
    const drop = async (gone: Message, text: string) => {
      found = found.filter((m) => m !== gone);
      act(() => {
        snowdrop.stores.messages.getState().remove(conv.id, gone.id);
      });
      await vi.waitFor(
        () => {
          expect(screen.queryByText(text)).toBeNull();
        },
        { timeout: 4000 },
      );
    };
    row('meeting two').focus();
    await drop(two, 'meeting two');
    expect(document.activeElement).toBe(row('meeting three'));
    await drop(three, 'meeting three');
    expect(document.activeElement).toBe(row('meeting one'));
    await drop(one, 'meeting one');
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it('takes focus only when the user opened the search, not when it moved from the page to a sheet', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId)[0]!;
    const chat = new ChatController();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const panel = (opened: boolean) => (
      <ChatControllerProvider value={chat}>
        <SearchPanel
          conversation={conv as unknown as ConversationView}
          query=""
          onQueryChange={vi.fn()}
          onClose={vi.fn()}
          onArrive={() => ({ opened, held: null })}
        />
      </ChatControllerProvider>
    );
    const view = renderWithSnowdrop(snowdrop, panel(false));
    expect(document.activeElement).toBe(outside);
    view.unmount();
    renderWithSnowdrop(snowdrop, panel(true));
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search messages' }));
    outside.remove();
  });

  it('does not search again for a change that cannot alter the results (a receipt, a reaction)', async () => {
    const one = hit('meeting at noon');
    const search = vi.fn(() => Promise.resolve([one]));
    const { snowdrop, conv, type } = await setup(search);
    snowdrop.stores.messages
      .getState()
      .replaceWindow(conv.id, [one], { hasMoreBefore: false, hasMoreAfter: false });
    type('meeting');
    await screen.findByText('meeting at noon');
    const searches = search.mock.calls.length;
    act(() => {
      snowdrop.stores.messages.getState().update(conv.id, one.id, (m) => ({
        ...m,
        status: 'read',
        reactions: [{ authorId: 'ana', emoji: '🎉', at: 1 }],
      }));
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(search).toHaveBeenCalledTimes(searches);
  });

  it('has no axe violations with results', async () => {
    const { view, type } = await setup(() => Promise.resolve([hit('meeting at noon')]));
    type('meeting');
    await screen.findByText('meeting at noon');
    expect(
      (await axe(view.container, { rules: { region: { enabled: false } } })).violations,
    ).toEqual([]);
  });
});
