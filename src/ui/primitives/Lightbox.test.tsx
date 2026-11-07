import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { Lightbox, type LightboxItem } from './Lightbox';
import { TooltipProvider } from './Tooltip';

afterEach(cleanup);

const items: LightboxItem[] = [
  { src: 'blob:a', kind: 'video', alt: 'clip' },
  { src: 'blob:b', kind: 'image', alt: 'photo' },
  { src: 'blob:c', kind: 'image', alt: 'other' },
];

function show(onIndexChange = vi.fn()) {
  render(
    <TooltipProvider>
      <Lightbox items={items} index={0} onIndexChange={onIndexChange} open onOpenChange={vi.fn()} />
    </TooltipProvider>,
  );
  return onIndexChange;
}

describe('Lightbox arrow keys', () => {
  it('steps between items from the viewer itself', () => {
    const onIndexChange = show();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(onIndexChange).toHaveBeenCalledWith(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
  });

  it("leaves Left and Right to a focused video's seeking", () => {
    const onIndexChange = show();
    const video = document.querySelector('video')!;
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    video.dispatchEvent(event);
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('still steps when the focus is on a button in the viewer', () => {
    const onIndexChange = show();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'ArrowRight' });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('has no axe violations', async () => {
    show();
    expect((await axe(screen.getByRole('dialog'))).violations.map((v) => v.id)).toEqual([]);
  }, 30_000);
});
