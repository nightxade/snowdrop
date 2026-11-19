import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { dismissToast, showToast, Toaster } from '@/ui/primitives';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  // The toast queue is global to the module: leave none behind for the next test.
  toast.dismiss();
  await snowdrop?.dispose();
  snowdrop = null;
});

const toastItems = () => [...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')];
const list = () => document.querySelector<HTMLElement>('[data-sonner-toaster]')!;

async function setup(count = 2, focusComposer = true) {
  snowdrop = await bootSnowdrop();
  renderWithSnowdrop(
    snowdrop,
    <>
      <textarea data-snowdrop="composer-input" aria-label="Message" />
      <button type="button">Other</button>
      <Toaster />
    </>,
  );
  const composer = screen.getByLabelText('Message');
  if (focusComposer) {
    act(() => {
      composer.focus();
    });
  }
  act(() => {
    for (let i = 0; i < count; i += 1)
      showToast({ id: `t${i}`, message: `Toast ${i}`, tone: 'info' });
  });
  await waitFor(() => {
    expect(toastItems()).toHaveLength(count);
  });
  return composer;
}

const altT = () => {
  act(() => {
    fireEvent.keyDown(document, { key: 't', code: 'KeyT', altKey: true });
  });
};

describe('focus in the toast list', () => {
  it('Esc returns focus to where it was before Alt+T', async () => {
    const composer = await setup();
    altT();
    expect(list().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(document.activeElement).toBe(composer);
    });
  });

  it('Esc returns to the last thing focused outside, even when focus was moved by a click first', async () => {
    await setup();
    const other = screen.getByRole('button', { name: 'Other' });
    act(() => {
      other.focus();
    });
    altT();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(document.activeElement).toBe(other);
    });
  });

  it('with nothing focused before Alt+T, Esc goes to the fallback, not back on a toast or the page', async () => {
    const composer = await setup(2, false);
    expect(document.activeElement).toBe(document.body);
    altT();
    act(() => {
      toastItems()[0]!.focus();
    });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(document.activeElement).toBe(composer);
    });
  });

  it('a focused toast that is dismissed hands focus to the next toast', async () => {
    await setup(3);
    const first = toastItems()[0]!;
    act(() => {
      first.focus();
    });
    const second = toastItems()[1]!;
    act(() => {
      dismissToast('t2');
    });
    await waitFor(() => {
      expect(first.isConnected).toBe(false);
    });
    expect(document.activeElement).not.toBe(document.body);
    expect(list().contains(document.activeElement)).toBe(true);
    expect(second.isConnected).toBe(true);
  });

  it('the last toast going hands focus back to where it was, never the page', async () => {
    const composer = await setup(1);
    act(() => {
      toastItems()[0]!.focus();
    });
    act(() => {
      dismissToast('t0');
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(composer);
    });
  });
});
