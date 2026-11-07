import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { use, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { Modal } from '@/ui/primitives';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ModalHost } from './ModalHost';

// A dialog whose body can wait on something after it is already showing.
const gate = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
  poke: () => {},
}));
vi.mock('./ShortcutsDialog', () => {
  function Body() {
    const [, setRenders] = useState(0);
    gate.poke = () => {
      setRenders((n) => n + 1);
    };
    if (gate.wait) use(gate.wait);
    return <p>shortcuts body</p>;
  }
  return {
    ShortcutsDialog: ({ onClose }: { onClose: () => void }) => (
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Keyboard shortcuts"
      >
        <Body />
      </Modal>
    ),
  };
});

const live: Snowdrop[] = [];
afterEach(async () => {
  gate.wait = null;
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

describe('ModalHost: a dialog that waits again after it is showing', () => {
  it('is not taken for a gone dialog while it is hidden behind the fallback', async () => {
    const snowdrop = await bootSnowdrop();
    live.push(snowdrop);
    renderWithSnowdrop(snowdrop, <ModalHost />);
    act(() => {
      snowdrop.stores.ui.getState().openModal({ type: 'shortcuts' });
    });
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await settle(snowdrop);
    let release = () => {};
    gate.wait = new Promise<void>((resolve) => {
      release = () => {
        gate.wait = null;
        resolve();
      };
    });
    // The body re-renders and has to wait: the boundary hides the dialog behind its fallback.
    act(() => {
      gate.poke();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(snowdrop.stores.ui.getState().modal).not.toBeNull();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => {
      expect(screen.getByText('shortcuts body')).toBeTruthy();
    });
    expect(snowdrop.stores.ui.getState().modal).not.toBeNull();
  });
});
