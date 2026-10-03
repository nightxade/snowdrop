import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { ConversationId } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { useReadTracking } from './useReadTracking';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

function Probe({ id, atPresent }: { id: ConversationId; atPresent: boolean }) {
  useReadTracking(id, atPresent);
  return null;
}

async function setup() {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const id = Object.keys(snowdrop.stores.conversations.getState().byId)[0] as ConversationId;
  act(() => {
    snowdrop.stores.ui.getState().selectConversation(id);
    snowdrop.stores.conversations.getState().setUnread(id, { count: 3, mentions: 0 });
  });
  const markRead = vi.spyOn(snowdrop.sync, 'markConversationRead').mockResolvedValue();
  return { snowdrop, id, markRead };
}

describe('useReadTracking', () => {
  it('does not mark read while the newest message is off screen, and says so to the sync engine', async () => {
    const { snowdrop, id, markRead } = await setup();
    act(() => {
      snowdrop.stores.ui.getState().setWindowFocused(true);
    });
    renderWithSnowdrop(snowdrop, <Probe id={id} atPresent={false} />);
    expect(markRead).not.toHaveBeenCalled();
    expect(snowdrop.stores.ui.getState().scrolledUp[id]).toBe(true);
  });

  it('marks read when the bottom is visible and the window has focus', async () => {
    const { snowdrop, id, markRead } = await setup();
    act(() => {
      snowdrop.stores.ui.getState().setWindowFocused(true);
    });
    renderWithSnowdrop(snowdrop, <Probe id={id} atPresent />);
    expect(markRead).toHaveBeenCalledWith(id);
    expect(snowdrop.stores.ui.getState().scrolledUp[id]).toBeUndefined();
  });

  it('waits for focus when the window is in the background', async () => {
    const { snowdrop, id, markRead } = await setup();
    act(() => {
      snowdrop.stores.ui.getState().setWindowFocused(false);
    });
    renderWithSnowdrop(snowdrop, <Probe id={id} atPresent />);
    expect(markRead).not.toHaveBeenCalled();
    act(() => {
      snowdrop.stores.ui.getState().setWindowFocused(true);
    });
    expect(markRead).toHaveBeenCalledWith(id);
  });
});
