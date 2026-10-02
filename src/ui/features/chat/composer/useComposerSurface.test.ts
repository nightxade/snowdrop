import { describe, expect, it } from 'vitest';
import { diffSpan } from './useComposerSurface';

describe('diffSpan', () => {
  it('finds the smallest replaced span', () => {
    expect(diffSpan('one two three', 'one three')).toEqual({ start: 5, end: 9, insert: '' });
    expect(diffSpan('abc', 'abXc')).toEqual({ start: 2, end: 2, insert: 'X' });
    expect(diffSpan('same', 'same')).toEqual({ start: 4, end: 4, insert: '' });
    expect(diffSpan('', 'new')).toEqual({ start: 0, end: 0, insert: 'new' });
  });

  it('never splits a surrogate pair', () => {
    // 😀 and 😁 share their high surrogate.
    const span = diffSpan('a😀b', 'a😁b');
    expect(span).toEqual({ start: 1, end: 3, insert: '😁' });
  });
});
