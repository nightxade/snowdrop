import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIO, installFakeIO } from '@/test/fakeIntersectionObserver';
import { useInView } from './useInView';

function Probe() {
  const [ref, inView] = useInView<HTMLDivElement>();
  return <div ref={ref} data-testid="probe" data-in-view={String(inView)} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useInView', () => {
  it('follows intersection changes with a single observer', () => {
    installFakeIO();
    render(<Probe />);
    expect(FakeIO.instances).toHaveLength(1);
    const probe = screen.getByTestId('probe');
    expect(FakeIO.instances[0]?.observed.has(probe)).toBe(true);
    act(() => FakeIO.instances[0]?.emit(false));
    expect(probe.dataset['inView']).toBe('false');
    act(() => FakeIO.instances[0]?.emit(true));
    expect(probe.dataset['inView']).toBe('true');
  });

  it('disconnects on unmount', () => {
    installFakeIO();
    const { unmount } = render(<Probe />);
    unmount();
    expect(FakeIO.instances[0]?.disconnected).toBe(true);
  });

  it('reports in view when IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<Probe />);
    expect(screen.getByTestId('probe').dataset['inView']).toBe('true');
  });
});
