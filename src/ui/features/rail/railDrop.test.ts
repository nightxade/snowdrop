import { describe, expect, it } from 'vitest';
import { canMerge, isMergeDrop } from './railDrop';

describe('rail drop geometry', () => {
  const target = { top: 100, height: 56 };
  it('merges only when the dragged tile centre is over the middle half', () => {
    expect(isMergeDrop({ top: 100, height: 56 }, target)).toBe(true);
    expect(isMergeDrop({ top: 112, height: 56 }, target)).toBe(true);
    expect(isMergeDrop({ top: 130, height: 56 }, target)).toBe(false);
    expect(isMergeDrop({ top: 70, height: 56 }, target)).toBe(false);
    expect(isMergeDrop(null, target)).toBe(false);
  });

  it('only spaces merge, never onto themselves', () => {
    expect(canMerge('space:a', 'space:b')).toBe(true);
    expect(canMerge('space:a', 'folder:f')).toBe(true);
    expect(canMerge('folder:f', 'space:b')).toBe(false);
    expect(canMerge('space:a', 'space:a')).toBe(false);
  });
});
