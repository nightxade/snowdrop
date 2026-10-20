import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIO, installFakeIO } from '@/test/fakeIntersectionObserver';
import { HistorySkeleton } from './HistorySkeleton';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HistorySkeleton', () => {
  it('marks the shimmer off while scrolled out of view and on again when visible', () => {
    installFakeIO();
    const { container } = render(<HistorySkeleton rows={3} />);
    const root = container.querySelector<HTMLElement>('[data-snowdrop="history-skeleton"]');
    expect(root?.hasAttribute('data-shimmer')).toBe(false);
    act(() => FakeIO.instances[0]?.emit(false));
    expect(root?.getAttribute('data-shimmer')).toBe('off');
    act(() => FakeIO.instances[0]?.emit(true));
    expect(root?.hasAttribute('data-shimmer')).toBe(false);
    expect(FakeIO.instances).toHaveLength(1);
  });
});
