import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { Drawer } from './Drawer';
import { FullScreenDialog } from './FullScreenDialog';
import { Lightbox } from './Lightbox';
import { Modal } from './Modal';
import { modalDialogOpen } from './modalOpen';
import { TooltipProvider } from './Tooltip';

afterEach(cleanup);

describe('modalDialogOpen', () => {
  it('is true for a Modal and a full-screen dialog, and not for a drawer or once closed', () => {
    const none = () => modalDialogOpen();
    expect(none()).toBe(false);
    const modal = render(
      <Modal open onOpenChange={vi.fn()} title="Rename">
        <input aria-label="Name" />
      </Modal>,
    );
    expect(modalDialogOpen()).toBe(true);
    modal.unmount();
    const full = render(
      <FullScreenDialog open onOpenChange={vi.fn()} title="Forward">
        <input aria-label="Name" />
      </FullScreenDialog>,
    );
    expect(modalDialogOpen()).toBe(true);
    full.unmount();
    const drawer = render(
      <Drawer open onOpenChange={vi.fn()} label="Navigation">
        <input aria-label="Name" />
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();
    expect(modalDialogOpen()).toBe(false);
    drawer.unmount();
    expect(modalDialogOpen()).toBe(false);
  });
});

describe('Modal', () => {
  it('has a labelled Close button, and axe is clean', async () => {
    render(
      <Modal open onOpenChange={vi.fn()} title="Rename" description="Pick a name">
        <input aria-label="Name" />
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect((await axe(screen.getByRole('dialog'))).violations.map((v) => v.id)).toEqual([]);
  });

  it('with a hidden header leaves no invisible Close in the Tab order, and Escape still closes', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal open onOpenChange={onOpenChange} title="Search" hideHeader>
        <input aria-label="Query" />
      </Modal>,
    );
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    const field = screen.getByLabelText('Query');
    expect(document.activeElement).toBe(field);
    await user.tab();
    // Nothing else to land on but the dialog's own focus scope: never a hidden button.
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('returns focus to what had it when a standalone dialog opened', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { rerender } = render(
      <Modal open onOpenChange={vi.fn()} title="One">
        <input aria-label="Field" />
      </Modal>,
    );
    expect(document.activeElement).not.toBe(opener);
    rerender(
      <Modal open={false} onOpenChange={vi.fn()} title="One">
        <input aria-label="Field" />
      </Modal>,
    );
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(document.activeElement).toBe(opener);
        opener.remove();
        resolve();
      }, 20);
    });
  });
});

const later = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

function withOpener() {
  const opener = document.createElement('button');
  opener.textContent = 'opener';
  document.body.append(opener);
  opener.focus();
  return opener;
}

describe('the shared opener hook', () => {
  it('in StrictMode still returns to what opened a Modal, not to something inside it', async () => {
    const opener = withOpener();
    const tree = (open: boolean) => (
      <StrictMode>
        <Modal open={open} onOpenChange={vi.fn()} title="One">
          <input aria-label="Field" />
        </Modal>
      </StrictMode>
    );
    const { rerender } = render(tree(true));
    rerender(tree(false));
    await later();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('returns focus to the opener from a FullScreenDialog', async () => {
    const opener = withOpener();
    const tree = (open: boolean) => (
      <FullScreenDialog open={open} onOpenChange={vi.fn()} title="Settings">
        <button type="button">Inside</button>
      </FullScreenDialog>
    );
    const { rerender } = render(tree(true));
    expect(document.activeElement).not.toBe(opener);
    rerender(tree(false));
    await later();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('returns focus to the opener from a Drawer', async () => {
    const opener = withOpener();
    const tree = (open: boolean) => (
      <Drawer open={open} onOpenChange={vi.fn()} label="Navigation">
        <button type="button">Inside</button>
      </Drawer>
    );
    const { rerender } = render(tree(true));
    expect(document.activeElement).not.toBe(opener);
    rerender(tree(false));
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
    });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('returns focus to the thumbnail that opened a Lightbox', async () => {
    const opener = withOpener();
    const tree = (open: boolean) => (
      <TooltipProvider>
        <Lightbox
          items={[{ src: 'blob:a', kind: 'image', alt: 'photo' }]}
          index={0}
          onIndexChange={vi.fn()}
          open={open}
          onOpenChange={vi.fn()}
        />
      </TooltipProvider>
    );
    const { rerender } = render(tree(true));
    rerender(tree(false));
    await later();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
