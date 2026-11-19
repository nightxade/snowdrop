import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetMenuOpener, rememberMenuOpener } from '@/ui/primitives/menuReturn';
import { neighbourOf, useHandOffRow, useHandOffWhenGone } from './useHandOffWhenGone';

afterEach(cleanup);

describe('neighbourOf', () => {
  it('takes the next row that is still there, else the previous one', () => {
    expect(neighbourOf(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
    expect(neighbourOf(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b');
    expect(neighbourOf(['a', 'b', 'c', 'd'], ['a', 'd'], 'b')).toBe('d');
    expect(neighbourOf(['a'], [], 'a')).toBeUndefined();
    expect(neighbourOf(['a', 'b'], ['a', 'b'], 'x')).toBeUndefined();
  });
});

function List({ ids }: { ids: readonly string[] }) {
  useHandOffRow({
    ids,
    identify: (el) => el.closest('[data-row]')?.getAttribute('data-row') ?? null,
    find: (id) => document.querySelector<HTMLElement>(`[data-row="${id}"]`),
    tabStop: () => document.querySelector<HTMLElement>('#stop'),
  });
  return (
    <div>
      <button id="stop">stop</button>
      {ids.map((id) => (
        <button key={id} data-row={id}>
          {id}
        </button>
      ))}
    </div>
  );
}

const focused = () =>
  document.activeElement?.getAttribute('data-row') ?? document.activeElement?.id;

describe('useHandOffRow', () => {
  it('hands focus to the next row, else the previous, else the list tab stop; leaves other focus alone', () => {
    const view = render(<List ids={['a', 'b', 'c']} />);
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
    act(() => {
      row('b').focus();
    });
    view.rerender(<List ids={['a', 'c']} />);
    expect(focused()).toBe('c');
    view.rerender(<List ids={['a']} />);
    expect(focused()).toBe('a');
    view.rerender(<List ids={[]} />);
    expect(focused()).toBe('stop');
    // Focus the user put elsewhere is not taken.
    view.rerender(<List ids={['a', 'b']} />);
    act(() => {
      row('a').focus();
    });
    act(() => {
      document.getElementById('stop')!.focus();
    });
    view.rerender(<List ids={['b']} />);
    expect(focused()).toBe('stop');
  });
});

function Menuable({
  ids,
  menu,
  split = false,
}: {
  ids: readonly string[];
  menu: boolean;
  split?: boolean;
}) {
  useHandOffRow({
    ids,
    identify: (el) => el.closest('[data-row]')?.getAttribute('data-row') ?? null,
    find: (id) => document.querySelector<HTMLElement>(`[data-row="${id}"]`),
  });
  const rows = ids.map((id) => (
    <button key={id} data-row={id}>
      {id}
    </button>
  ));
  return (
    <div>
      {split ? rows.map((row) => <section key={row.key}>{row}</section>) : rows}
      {menu && (
        <div role="menu">
          <button role="menuitem" id="item">
            item
          </button>
        </div>
      )}
    </div>
  );
}

describe('a row whose menu had focus', () => {
  it('counts as the focused row: when the chosen item removes it, focus goes to its neighbour once the menu is gone', async () => {
    const view = render(<Menuable ids={['a', 'b', 'c']} menu={false} />);
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
    act(() => {
      row('b').focus();
    });
    // A context menu opened from the row: it remembers its opener and takes focus.
    rememberMenuOpener();
    view.rerender(<Menuable ids={['a', 'b', 'c']} menu />);
    act(() => {
      document.getElementById('item')!.focus();
    });
    // The item is chosen: the row goes while the menu is still open, then the menu closes.
    view.rerender(<Menuable ids={['a', 'c']} menu />);
    expect(document.activeElement?.id).toBe('item');
    view.rerender(<Menuable ids={['a', 'c']} menu={false} />);
    forgetMenuOpener();
    await waitFor(() => {
      expect(focused()).toBe('c');
    });
  });

  it('gets focus back on the same row when it is mounted anew', async () => {
    const view = render(<Menuable ids={['a', 'b']} menu={false} />);
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
    act(() => {
      row('b').focus();
    });
    rememberMenuOpener();
    view.rerender(<Menuable ids={['a', 'b']} menu />);
    act(() => {
      document.getElementById('item')!.focus();
    });
    const before = row('b');
    // Filed under another heading: the same row, mounted again.
    view.rerender(<Menuable ids={['a', 'b']} menu split />);
    expect(row('b')).not.toBe(before);
    view.rerender(<Menuable ids={['a', 'b']} menu={false} split />);
    forgetMenuOpener();
    await waitFor(() => {
      expect(focused()).toBe('b');
    });
  });
});

function Tile({ nested }: { nested: boolean }) {
  useHandOffWhenGone({
    identify: (el) => el.closest('[data-tile]')?.getAttribute('data-tile') ?? null,
    stillThere: () => true,
    again: (id) => document.querySelector<HTMLElement>(`[data-tile="${id}"]`),
  });
  const button = <button data-tile="t">tile</button>;
  return nested ? <div>{button}</div> : button;
}

describe('useHandOffWhenGone: a thing that stays but is mounted anew', () => {
  it('gives focus back on its new element', () => {
    const view = render(<Tile nested={false} />);
    act(() => {
      document.querySelector<HTMLElement>('[data-tile]')!.focus();
    });
    view.rerender(<Tile nested />);
    expect(document.activeElement).toBe(document.querySelector('[data-tile]'));
    expect(document.activeElement?.getAttribute('data-tile')).toBe('t');
  });

  it('does not take focus the user left by clicking off the page', async () => {
    const view = render(<Tile nested={false} />);
    const tile = document.querySelector<HTMLElement>('[data-tile]')!;
    act(() => {
      tile.focus();
    });
    act(() => {
      tile.blur();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    view.rerender(<Tile nested />);
    expect(document.activeElement).toBe(document.body);
  });
});
