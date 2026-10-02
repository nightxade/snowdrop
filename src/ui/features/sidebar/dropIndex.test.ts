import { describe, expect, it } from 'vitest';
import { renderedInsertIndex, storeInsertIndex } from './dropIndex';

describe('category drop index', () => {
  it('inserts before the first row whose middle is below the pointer', () => {
    expect(renderedInsertIndex([10, 30, 50], 5)).toBe(0);
    expect(renderedInsertIndex([10, 30, 50], 31)).toBe(2);
    expect(renderedInsertIndex([10, 30, 50], 99)).toBe(3);
    expect(renderedInsertIndex([], 99)).toBe(0);
  });

  it('maps rendered positions to store indices, accounting for removal first', () => {
    const full = ['a', 'b', 'c', 'd'];
    // Moving a down to just before d: after removal it lands at index 2.
    expect(storeInsertIndex(full, full, 3, 'a')).toBe(2);
    // Moving d up before b.
    expect(storeInsertIndex(full, full, 1, 'd')).toBe(1);
    // From another category to the end.
    expect(storeInsertIndex(full, full, 4, 'x')).toBe(4);
    // Collapsed category: only c rendered; dropping before c.
    expect(storeInsertIndex(full, ['c'], 0, 'x')).toBe(2);
  });
});
