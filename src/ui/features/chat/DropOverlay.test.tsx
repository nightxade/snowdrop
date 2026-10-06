/**
 * `useFileDrop`'s enter/leave depth counter (DropOverlay.tsx) can desync in
 * WebKit when a row unmounts mid-drag and its own `dragleave` never fires,
 * leaving the overlay stuck open. The window-level `dragend`/`drop` and a
 * window-leaving `dragleave` (`relatedTarget === null`) are the recovery
 * paths for that — this exercises each one directly.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFileDrop } from './DropOverlay';

afterEach(cleanup);

const filesTransfer = { types: ['Files'], files: [] as File[] };

function Harness({ onFiles }: { onFiles: (files: File[]) => void }) {
  const { dragging, handlers } = useFileDrop(onFiles);
  return (
    <div data-testid="drop-zone" {...handlers}>
      {dragging ? 'dragging' : 'idle'}
    </div>
  );
}

describe('useFileDrop: recovering a desynced depth counter', () => {
  it('resets on a window dragend even though depth never reached zero on its own', () => {
    const { getByTestId } = render(<Harness onFiles={vi.fn()} />);
    const zone = getByTestId('drop-zone');

    // Two enters with no matching leave in between — as if a row's own
    // dragleave got lost when it unmounted mid-drag — leave depth at 2.
    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer });
    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer });
    expect(zone.textContent).toBe('dragging');

    act(() => {
      window.dispatchEvent(new Event('dragend'));
    });
    expect(zone.textContent).toBe('idle');

    // Depth is genuinely back at zero (not just `dragging` forced false): a
    // single fresh enter/leave pair cleanly toggles it again.
    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer });
    expect(zone.textContent).toBe('dragging');
    fireEvent.dragLeave(zone, { relatedTarget: document.body });
    expect(zone.textContent).toBe('idle');
  });

  it('resets on a window drop', () => {
    const { getByTestId } = render(<Harness onFiles={vi.fn()} />);
    const zone = getByTestId('drop-zone');
    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer });
    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer });

    act(() => {
      window.dispatchEvent(new Event('drop'));
    });
    expect(zone.textContent).toBe('idle');

    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer });
    expect(zone.textContent).toBe('dragging');
    fireEvent.dragLeave(zone, { relatedTarget: document.body });
    expect(zone.textContent).toBe('idle');
  });

  it('resets immediately on a dragleave with no relatedTarget, regardless of depth', () => {
    const { getByTestId } = render(<Harness onFiles={vi.fn()} />);
    const zone = getByTestId('drop-zone');
    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer });
    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer });
    expect(zone.textContent).toBe('dragging');

    // The drag left the window itself, not just a child element. happy-dom's
    // event map doesn't construct a real DragEvent for "dragleave" (so
    // `fireEvent`'s `relatedTarget` init is silently dropped) — dispatch one
    // directly so `relatedTarget` is actually `null` on the event the
    // handler sees.
    const leftWindow = new Event('dragleave', { bubbles: true, cancelable: true });
    Object.defineProperty(leftWindow, 'relatedTarget', { value: null });
    fireEvent(zone, leftWindow);
    expect(zone.textContent).toBe('idle');
  });

  it('removes its window listeners on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Harness onFiles={vi.fn()} />);
    const added = addSpy.mock.calls.filter(([type]) => type === 'dragend' || type === 'drop');
    expect(added.length).toBe(2);

    unmount();
    const removed = removeSpy.mock.calls.filter(([type]) => type === 'dragend' || type === 'drop');
    expect(removed.length).toBe(2);
  });
});
