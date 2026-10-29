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
      <SearchPanel conversation={conv as unknown as ConversationView} onClose={vi.fn()} />
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

  it('has no axe violations with results', async () => {
    const { view, type } = await setup(() => Promise.resolve([hit('meeting at noon')]));
    type('meeting');
    await screen.findByText('meeting at noon');
    expect(
      (await axe(view.container, { rules: { region: { enabled: false } } })).violations,
    ).toEqual([]);
  });
});
