import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import { mergeDuplicate, type Message } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { sessionSelectors, uiSelectors } from '@/core/stores';
import { followConversationOpenFocus } from '@/ui/hooks';
import { bootDemo, disposeAll, key, settle, setViewport } from '@/test/bootDemo';

vi.mock('@/ui/hooks', async (importOriginal) => {
  const hooks = await importOriginal<Record<string, unknown>>();
  return {
    ...hooks,
    followConversationOpenFocus: vi.fn(hooks['followConversationOpenFocus'] as () => void),
  };
});

beforeEach(() => {
  setViewport(1440);
});

afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  await disposeAll();
});

const selected = (s: Snowdrop) => uiSelectors.selectedConversation(s.stores.ui.getState());

async function seed(snowdrop: Snowdrop, bodies: string[]): Promise<Message[]> {
  const ids = Object.keys(snowdrop.stores.conversations.getState().byId);
  const out: Message[] = [];
  let at = 9_000_000_000_000;
  for (const [i, body] of bodies.entries()) {
    const m = makeMessage({
      conversationId: ids[i % 2] as Message['conversationId'],
      authorId: 'seed-author',
      sentAt: at++,
      body,
    });
    const { seq: _seq, ...incoming } = m;
    out.push((await snowdrop.repository.upsert(incoming, mergeDuplicate)).message);
  }
  return out;
}

async function open() {
  key({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true });
  const input = await screen.findByRole('combobox', { name: 'Search all chats' });
  return { input, dialog: screen.getByRole('dialog') };
}

const type = (input: HTMLElement, value: string) => {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
};

describe('Search all chats', () => {
  it('opens from Mod+Shift+F with focus in the field, and leaves Mod+F for the chat', async () => {
    await bootDemo();
    const { input } = await open();
    expect(document.activeElement).toBe(input);
    key({ key: 'Escape' }, input);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    key({ key: 'f', code: 'KeyF', ctrlKey: true });
    expect(screen.queryByRole('combobox', { name: 'Search all chats' })).toBeNull();
  });

  it('opens from the sidebar button', async () => {
    await bootDemo();
    const header = document.querySelector<HTMLElement>('[data-snowdrop="sidebar-header"]')!;
    act(() => {
      fireEvent.click(within(header).getByRole('button', { name: 'Search all chats' }));
    });
    expect(await screen.findByRole('combobox', { name: 'Search all chats' })).toBeTruthy();
  });

  it('lists messages from every conversation with a highlighted snippet, then jumps', async () => {
    const snowdrop = await bootDemo();
    const seeded = await seed(snowdrop, ['first zebrafish sighting', 'second zebrafish sighting']);
    const { input, dialog } = await open();
    type(input, 'zebrafish');
    const options = await within(dialog).findAllByRole('option');
    expect(options).toHaveLength(2);
    // Newest first, matched word marked.
    expect(options[0]!.textContent).toContain('second');
    expect(options[0]!.querySelector('mark')?.textContent).toBe('zebrafish');
    key({ key: 'Enter' }, input);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(selected(snowdrop)).toBe(seeded[1]!.conversationId);
    // The request was handed to the chat column and consumed.
    expect(snowdrop.stores.ui.getState().revealRequest).toBeNull();
  });

  it('walks the results with the arrow keys and opens the chosen one on click', async () => {
    const snowdrop = await bootDemo();
    const seeded = await seed(snowdrop, ['first zebrafish', 'second zebrafish']);
    const { input, dialog } = await open();
    type(input, 'zebrafish');
    const options = await within(dialog).findAllByRole('option');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    key({ key: 'ArrowDown' }, input);
    expect(
      within(dialog)
        .getAllByRole('option')
        .findIndex((o) => o.getAttribute('aria-selected') === 'true'),
    ).toBe(1);
    act(() => {
      fireEvent.click(within(dialog).getAllByRole('option')[1]!);
    });
    await settle();
    expect(selected(snowdrop)).toBe(seeded[0]!.conversationId);
  });

  it('matches conversations by name before messages', async () => {
    const snowdrop = await bootDemo();
    const { input, dialog } = await open();
    type(input, 'orchard');
    const options = await within(dialog).findAllByRole('option');
    expect(options[0]!.querySelector('mark')?.textContent.toLowerCase()).toContain('orchard');
    key({ key: 'Enter' }, input);
    await settle();
    expect(selected(snowdrop)).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('finds an archived chat by name and marks it archived, as the quick switcher does (S21)', async () => {
    const snowdrop = await bootDemo();
    const groups = Object.values(snowdrop.stores.conversations.getState().byId).filter(
      (c) => c.kind === 'group',
    );
    const group = groups[0]!;
    const title = snowdrop.stores.conversations.getState().byId[group.id]!.title;
    const { input, dialog } = await open();
    type(input, title.slice(0, 5));
    await within(dialog).findAllByRole('option');
    expect(within(dialog).queryByText('Archived')).toBeNull();
    act(() => {
      snowdrop.stores.local.getState().setArchived(group.id, true);
    });
    await waitFor(() => {
      expect(within(dialog).getByText('Archived')).toBeTruthy();
    });
  });

  it('follows live changes from the stores without searching storage again', async () => {
    const snowdrop = await bootDemo();
    const [keep, gone] = await seed(snowdrop, ['kept zebrafish', 'gone zebrafish']);
    const flags = { hasMoreBefore: false, hasMoreAfter: false };
    snowdrop.stores.messages.getState().replaceWindow(keep!.conversationId, [keep!], flags);
    snowdrop.stores.messages.getState().replaceWindow(gone!.conversationId, [gone!], flags);
    const search = vi.spyOn(snowdrop.repository, 'search');
    const { input, dialog } = await open();
    type(input, 'zebrafish');
    await within(dialog).findByText('gone');
    // The second result (the older, "kept") is the highlighted one; deleting the first leaves it.
    key({ key: 'ArrowDown' }, input);
    const scans = search.mock.calls.length;
    act(() => {
      snowdrop.stores.messages.getState().remove(gone!.conversationId, gone!.id);
    });
    await waitFor(() => {
      expect(within(dialog).queryByText('gone')).toBeNull();
    });
    expect(within(dialog).getByText('kept')).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(
      within(dialog)
        .getAllByRole('option')
        .some((o) => o.getAttribute('aria-selected') === 'true'),
    ).toBe(true);

    // A new matching message joins, newest first; one that does not match stays out.
    const fresh = makeMessage({
      conversationId: keep!.conversationId,
      authorId: 'seed-author',
      sentAt: 9_000_000_000_100,
      body: 'fresh zebrafish',
    });
    const other = makeMessage({
      conversationId: keep!.conversationId,
      authorId: 'seed-author',
      sentAt: 9_000_000_000_200,
      body: 'unrelated words',
    });
    act(() => {
      snowdrop.stores.messages.getState().appendLive(fresh);
      snowdrop.stores.messages.getState().appendLive(other);
    });
    await within(dialog).findByText('fresh');
    expect(within(dialog).queryByText(/unrelated/u)).toBeNull();
    expect(within(dialog).getAllByRole('option')[0]!.textContent).toContain('fresh');

    // An edit that no longer matches removes it.
    act(() => {
      snowdrop.stores.messages
        .getState()
        .update(fresh.conversationId, fresh.id, (m) => ({ ...m, body: 'fresh carp', edits: 1 }));
    });
    await waitFor(() => {
      expect(within(dialog).queryByText('fresh')).toBeNull();
    });
    expect(search.mock.calls.length).toBe(scans);
  });

  it('opens a chat found by name the way every other opener does, so the focus policy is told', async () => {
    const snowdrop = await bootDemo();
    const { input, dialog } = await open();
    type(input, 'orchard');
    await within(dialog).findAllByRole('option');
    vi.mocked(followConversationOpenFocus).mockClear();
    key({ key: 'Enter' }, input);
    await settle();
    const opened = selected(snowdrop);
    expect(opened).not.toBeNull();
    expect(followConversationOpenFocus).toHaveBeenCalledWith(opened);
  });

  it('says so when nothing matches, and that only this device is searched', async () => {
    await bootDemo();
    const { input, dialog } = await open();
    type(input, 'qqqzzzxx');
    await waitFor(() => {
      expect(within(dialog).getByText(/No results for/u)).toBeTruthy();
    });
    expect(within(dialog).getByText(/stored on this device/u)).toBeTruthy();
  });

  it('shows a loading state while the scan runs', async () => {
    const snowdrop = await bootDemo();
    vi.spyOn(snowdrop.repository, 'search').mockImplementation(() => new Promise(() => undefined));
    const { input, dialog } = await open();
    type(input, 'zebrafish');
    await waitFor(() => {
      expect(within(dialog).getByRole('status', { name: '' }).textContent).toContain('Searching');
    });
  });

  it('never lets a slow, stale query overwrite a newer one', async () => {
    const snowdrop = await bootDemo();
    await seed(snowdrop, ['alpha one', 'beta two']);
    const real = snowdrop.repository.search.bind(snowdrop.repository);
    const resolvers: (() => void)[] = [];
    const signals = new Map<string, AbortSignal>();
    vi.spyOn(snowdrop.repository, 'search').mockImplementation((text, q) => {
      if (q.signal) signals.set(text, q.signal);
      const result = real(text, { ...q, signal: undefined as never });
      return text === 'alpha'
        ? new Promise((resolve) => {
            resolvers.push(() => {
              void result.then(resolve);
            });
          })
        : result;
    });
    const { input, dialog } = await open();
    type(input, 'alpha');
    await waitFor(() => {
      expect(signals.has('alpha')).toBe(true);
    });
    type(input, 'beta');
    await within(dialog).findByText('two');
    expect(signals.get('alpha')?.aborted).toBe(true);
    // The old query finally answers; it must not replace the new results.
    await act(async () => {
      resolvers.forEach((r) => {
        r();
      });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(within(dialog).queryByText('one')).toBeNull();
    expect(within(dialog).getByText('two')).toBeTruthy();
  });

  it('warns while the phone history is still importing', async () => {
    const snowdrop = await bootDemo();
    snowdrop.stores.session.getState().setHistoryImport({ status: 'importing' } as never);
    expect(sessionSelectors.historyImport(snowdrop.stores.session.getState()).status).toBe(
      'importing',
    );
    const { dialog } = await open();
    expect(within(dialog).getByText(/Still importing/u)).toBeTruthy();
  });

  it('has no axe violations with results showing', async () => {
    const snowdrop = await bootDemo();
    await seed(snowdrop, ['axe zebrafish one', 'axe zebrafish two']);
    const { input, dialog } = await open();
    type(input, 'zebrafish');
    await within(dialog).findAllByRole('option');
    const results = await axe(dialog, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
