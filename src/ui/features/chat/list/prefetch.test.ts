import { describe, expect, it } from 'vitest';
import { PREFETCH_ROWS, prefetchEdges } from './prefetch';

describe('prefetchEdges', () => {
  it('requests nothing when the rendered range is well inside the loaded window', () => {
    const decision = prefetchEdges({ startIndex: 500, endIndex: 520 }, 0, 1000, {
      hasMoreBefore: true,
      anchoredToPresent: false,
    });
    expect(decision).toEqual({ loadOlder: false, loadNewer: false });
  });

  it('requests the older page once the rendered range is within the threshold of the start', () => {
    const atThreshold = prefetchEdges(
      { startIndex: PREFETCH_ROWS, endIndex: PREFETCH_ROWS + 10 },
      0,
      1000,
      { hasMoreBefore: true, anchoredToPresent: true },
    );
    expect(atThreshold.loadOlder).toBe(true);

    const justOutside = prefetchEdges(
      { startIndex: PREFETCH_ROWS + 1, endIndex: PREFETCH_ROWS + 11 },
      0,
      1000,
      { hasMoreBefore: true, anchoredToPresent: true },
    );
    expect(justOutside.loadOlder).toBe(false);
  });

  it('never requests an older page once history has run out, however close to the start', () => {
    const decision = prefetchEdges({ startIndex: 0, endIndex: 10 }, 0, 1000, {
      hasMoreBefore: false,
      anchoredToPresent: true,
    });
    expect(decision.loadOlder).toBe(false);
  });

  it('requests the newer page once a detached window is within the threshold of its end', () => {
    const last = 999;
    const decision = prefetchEdges(
      { startIndex: last - 40, endIndex: last - PREFETCH_ROWS },
      0,
      1000,
      { hasMoreBefore: true, anchoredToPresent: false },
    );
    expect(decision.loadNewer).toBe(true);
  });

  it('never requests a newer page once the window is anchored to the present', () => {
    const last = 999;
    const decision = prefetchEdges({ startIndex: last - 5, endIndex: last }, 0, 1000, {
      hasMoreBefore: true,
      anchoredToPresent: true,
    });
    expect(decision.loadNewer).toBe(false);
  });

  it('can request both edges at once for a short, fully-detached window', () => {
    const decision = prefetchEdges({ startIndex: 0, endIndex: 9 }, 0, 10, {
      hasMoreBefore: true,
      anchoredToPresent: false,
    });
    expect(decision).toEqual({ loadOlder: true, loadNewer: true });
  });
});
