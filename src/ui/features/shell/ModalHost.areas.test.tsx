/** A dialog that crashes (or whose chunk fails to load) closes into a fallback instead of taking the app down. */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ModalHost } from './ModalHost';

vi.mock('./ShortcutsDialog', () => ({
  ShortcutsDialog: () => {
    throw new Error('dialog boom');
  },
}));

const live: Snowdrop[] = [];
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
});

describe('ModalHost areas', () => {
  it('shows a fallback dialog that can be closed, clearing the modal', async () => {
    const snowdrop = await bootSnowdrop();
    live.push(snowdrop);
    renderWithSnowdrop(snowdrop, <ModalHost />);
    act(() => {
      snowdrop.stores.ui.getState().openModal({ type: 'shortcuts' });
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Something went wrong showing this dialog.');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(snowdrop.stores.ui.getState().modal).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
