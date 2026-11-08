import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { colorForId, type Contact } from '@/core/domain';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ContactChecklist } from './ContactChecklist';

const snowdrops: Snowdrop[] = [];

afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

async function renderBook(size: number): Promise<void> {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  renderWithSnowdrop(snowdrop, <Harness contacts={book(size)} />);
}

const book = (size: number): Contact[] =>
  Array.from({ length: size }, (_, i) => ({
    id: `c${i}`,
    name: `Person ${String(i).padStart(4, '0')}`,
    color: colorForId(`c${i}`),
  }));

function Harness({ contacts }: { contacts: Contact[] }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <VirtuosoMockContext.Provider value={{ viewportHeight: 320, itemHeight: 44 }}>
      <ContactChecklist
        contacts={contacts}
        selected={selected}
        onChange={setSelected}
        label="People"
        searchLabel="Search people"
        empty="Nobody."
      />
    </VirtuosoMockContext.Provider>
  );
}

async function showRows(): Promise<void> {
  await waitFor(() => {
    act(() => {
      document.querySelectorAll('[data-virtuoso-scroller]').forEach((el) => {
        el.dispatchEvent(new Event('scroll'));
      });
    });
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
  });
}

describe('ContactChecklist with a large address book', () => {
  it('mounts only the rows near the viewport and numbers them out of the whole list', async () => {
    await renderBook(3000);
    await showRows();
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeLessThan(80);
    expect(rows[0]?.getAttribute('aria-setsize')).toBe('3000');
    expect(rows[0]?.getAttribute('aria-posinset')).toBe('1');
    expect((await axe(screen.getByRole('list', { name: 'People' }))).violations).toEqual([]);
  });

  it('keeps picking, the count and the chips working', async () => {
    await renderBook(3000);
    await showRows();
    const first = screen.getAllByRole('checkbox')[0]!;
    act(() => {
      first.focus();
      fireEvent.click(first);
    });
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Person 0000' })).toBeTruthy();
    expect(document.activeElement).toBe(first);
  });

  it('searches the whole book, not just the rows that are mounted', async () => {
    await renderBook(3000);
    await showRows();
    act(() => {
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), {
        target: { value: 'Person 2999' },
      });
    });
    await showRows();
    expect(screen.getAllByRole('checkbox')[0]?.closest('li')?.textContent).toContain('Person 2999');
  });

  it('renders a short list whole, without windowing', async () => {
    await renderBook(10);
    expect(screen.getAllByRole('checkbox')).toHaveLength(10);
    expect(document.querySelector('[data-virtuoso-scroller]')).toBeNull();
  });
});
