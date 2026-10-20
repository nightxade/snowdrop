import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIO, installFakeIO } from '@/test/fakeIntersectionObserver';
import { ListSkeleton } from './ConversationList';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ListSkeleton', () => {
  it('marks the shimmer off while not intersecting', () => {
    installFakeIO();
    render(<ListSkeleton />);
    const root = screen.getByLabelText('Loading conversations');
    expect(root.hasAttribute('data-shimmer')).toBe(false);
    act(() => FakeIO.instances[0]?.emit(false));
    expect(root.getAttribute('data-shimmer')).toBe('off');
    act(() => FakeIO.instances[0]?.emit(true));
    expect(root.hasAttribute('data-shimmer')).toBe(false);
  });
});
