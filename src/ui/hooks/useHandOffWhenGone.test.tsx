import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { neighbourOf, useHandOffRow } from './useHandOffWhenGone';

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
