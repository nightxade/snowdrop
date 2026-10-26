import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootForward } from '@/test/forwardKit';
import { renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ModalHost } from './ModalHost';

const live: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

async function host() {
  const kit = await bootForward();
  live.push(kit.snowdrop);
  renderWithSnowdrop(kit.snowdrop, <ModalHost />);
  return kit;
}

describe('ModalHost: forward', () => {
  it('shows the forward dialog for the message the modal names', async () => {
    const { snowdrop, conversationId, message } = await host();
    act(() => {
      snowdrop.stores.ui.getState().openModal({
        type: 'forward',
        props: { conversationId, messageIds: [message.id] },
      });
    });
    await settle(snowdrop);
    expect(await screen.findByRole('dialog', { name: 'Forward to' })).toBeTruthy();
    expect(screen.getByText('worth keeping')).toBeTruthy();
  });

  it('shows nothing for a modal missing its conversation or messages', async () => {
    const { snowdrop, conversationId } = await host();
    act(() => {
      snowdrop.stores.ui.getState().openModal({ type: 'forward', props: { messageIds: ['x'] } });
    });
    await settle(snowdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      snowdrop.stores.ui.getState().openModal({
        type: 'forward',
        props: { conversationId, messageIds: [] },
      });
    });
    await settle(snowdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes itself when the messages are gone', async () => {
    const { snowdrop, conversationId } = await host();
    act(() => {
      snowdrop.stores.ui.getState().openModal({
        type: 'forward',
        props: { conversationId, messageIds: ['nobody:1'] },
      });
    });
    await settle(snowdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(snowdrop.stores.ui.getState().modal).toBeNull();
  });
});
