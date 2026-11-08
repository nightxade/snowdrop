import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { VirtuosoMockContext } from 'react-virtuoso';
import type { Snowdrop } from '@/app/createSnowdrop';
import { colorForId, type Contact } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { uiSelectors } from '@/core/stores';
import { NewMessageDialog } from './NewMessageDialog';
import { composableContacts } from './model';

const BOOK = 3000;
const snowdrops: Snowdrop[] = [];

afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

const nameOf = (n: number) => `Person ${String(n).padStart(4, '0')}`;

async function bootBook(): Promise<Snowdrop> {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const contacts: Contact[] = Array.from({ length: BOOK }, (_, i) => ({
    id: `book-${i}`,
    name: nameOf(i),
    color: colorForId(`book-${i}`),
    number: `+1555${String(1000000 + i)}`,
  }));
  act(() => {
    snowdrop.stores.contacts.getState().upsertMany(contacts);
  });
  return snowdrop;
}

/** Virtuoso's mock only renders rows once its scroller sees a scroll event. */
async function render(snowdrop: Snowdrop, ui: React.ReactElement): Promise<void> {
  renderWithSnowdrop(
    snowdrop,
    <VirtuosoMockContext.Provider value={{ viewportHeight: 400, itemHeight: 40 }}>
      {ui}
    </VirtuosoMockContext.Provider>,
  );
  await settle(snowdrop);
  await waitFor(() => {
    act(() => {
      document.querySelectorAll('[data-virtuoso-scroller]').forEach((el) => {
        el.dispatchEvent(new Event('scroll'));
      });
    });
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  });
}

describe('New message with a large address book', () => {
  it('mounts only the rows near the viewport, and says how many there are', async () => {
    const snowdrop = await bootBook();
    await render(snowdrop, <NewMessageDialog onClose={() => undefined} />);
    const options = screen.getAllByRole('option');
    expect(options.length).toBeLessThan(120);
    expect(options.every((o) => o.getAttribute('aria-setsize') !== null)).toBe(true);
    expect(Number(options[0]?.getAttribute('aria-setsize'))).toBeGreaterThanOrEqual(BOOK);
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });

  const field = () => screen.getByRole('combobox', { name: 'Name, username or number' });
  const press = (key: string) => {
    act(() => {
      fireEvent.keyDown(field(), { key });
    });
  };
  /** Scrolls the list to `top` (the mock list has no layout of its own) and says which row is active. */
  const scrollTo = async (top: number) => {
    await act(async () => {
      document.querySelectorAll<HTMLElement>('[data-virtuoso-scroller]').forEach((el) => {
        el.scrollTop = top;
        el.dispatchEvent(new Event('scroll'));
      });
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  /** The end of the list: every row is 40px in the mock (two of them headings). */
  const bottom = () =>
    (Number(screen.getAllByRole('option')[0]?.getAttribute('aria-setsize')) + 2) * 40 - 400;
  const activeRow = () =>
    document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? null;

  it('End makes the last contact active, not the last one that happens to be mounted', async () => {
    const snowdrop = await bootBook();
    await render(snowdrop, <NewMessageDialog onClose={() => undefined} />);
    press('End');
    await scrollTo(bottom());
    await waitFor(() => {
      // The demo's own contacts sort after "Person ####"; the last row is whoever sorts last.
      const rows = screen.getAllByRole('option');
      expect(rows.at(-1)?.getAttribute('aria-posinset')).toBe(
        rows.at(-1)?.getAttribute('aria-setsize'),
      );
      expect(activeRow()).toBe(rows.at(-1)?.textContent);
    });
  });

  it('Up from the first row wraps to the last, and Down from the last wraps to the first', async () => {
    const snowdrop = await bootBook();
    await render(snowdrop, <NewMessageDialog onClose={() => undefined} />);
    expect(activeRow()).toContain('New group');
    press('ArrowUp');
    await scrollTo(bottom());
    await waitFor(() => {
      const rows = screen.getAllByRole('option');
      expect(activeRow()).toBe(rows.at(-1)?.textContent);
    });
    press('ArrowDown');
    await scrollTo(0);
    await waitFor(() => {
      expect(activeRow()).toContain('New group');
    });
  });

  it('searching narrows the book to a short list, which is rendered whole', async () => {
    const snowdrop = await bootBook();
    await render(snowdrop, <NewMessageDialog onClose={() => undefined} />);
    act(() => {
      fireEvent.change(field(), { target: { value: 'Person 2999' } });
    });
    await waitFor(() => {
      const options = screen.getAllByRole('option');
      expect(options.length).toBeLessThanOrEqual(80);
      expect(options.length).toBeGreaterThanOrEqual(1);
      expect(options.some((o) => o.getAttribute('aria-setsize') !== null)).toBe(false);
    });
  });

  /** Who the dialog opened: the title of the selected conversation. */
  const opened = (snowdrop: Snowdrop) => {
    const id = uiSelectors.selectedConversation(snowdrop.stores.ui.getState());
    return id ? snowdrop.stores.conversations.getState().byId[id]?.title : undefined;
  };
  /** The contacts in the order the dialog lists them. */
  const listed = (snowdrop: Snowdrop) =>
    composableContacts(
      snowdrop.stores.contacts.getState().byId,
      snowdrop.stores.session.getState().self?.id ?? null,
    ).map((c) => c.name);

  describe('the highlighted row survives leaving the window', () => {
    it('Enter opens the highlighted contact after it has scrolled out of the window', async () => {
      const snowdrop = await bootBook();
      await render(snowdrop, <NewMessageDialog onClose={() => undefined} />);
      for (let i = 0; i < 6; i++) press('ArrowDown');
      const chosen = activeRow();
      expect(chosen).not.toBeNull();
      await scrollTo(bottom());
      await waitFor(() => {
        // The highlighted row is no longer mounted.
        expect(activeRow()).toBeNull();
      });
      press('Enter');
      expect(chosen).toContain(opened(snowdrop));
    });

    it('Home then Enter chooses the first row, and End then Enter the last, at once', async () => {
      const snowdrop = await bootBook();
      await render(snowdrop, <NewMessageDialog onClose={() => undefined} />);
      press('End');
      press('Enter');
      expect(opened(snowdrop)).toBe(listed(snowdrop).at(-1));
    });

    it('Ctrl+N and Ctrl+P step on from the real position, across the window edge', async () => {
      const snowdrop = await bootBook();
      await render(snowdrop, <NewMessageDialog onClose={() => undefined} />);
      // Row 0 is "New group"; five steps down is the fifth contact.
      for (let i = 0; i < 5; i++) press('ArrowDown');
      await scrollTo(bottom());
      await waitFor(() => {
        expect(activeRow()).toBeNull();
      });
      act(() => {
        fireEvent.keyDown(field(), { key: 'n', ctrlKey: true });
      });
      press('Enter');
      expect(opened(snowdrop)).toBe(listed(snowdrop)[5]);
    });

    it('Meta+ArrowDown goes to the real last row', async () => {
      const snowdrop = await bootBook();
      await render(snowdrop, <NewMessageDialog onClose={() => undefined} />);
      act(() => {
        fireEvent.keyDown(field(), { key: 'ArrowDown', metaKey: true });
      });
      press('Enter');
      expect(opened(snowdrop)).toBe(listed(snowdrop).at(-1));
    });
  });
});
