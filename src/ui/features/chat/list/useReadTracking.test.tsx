import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Shrike } from '@/app/createShrike';
import type { ConversationId } from '@/core/domain';
import { bootShrike, renderWithShrike } from '@/test/renderWithShrike';
import { useReadTracking } from './useReadTracking';

const shrikes: Shrike[] = [];
afterEach(async () => {
  cleanup();
  for (const s of shrikes.splice(0)) await s.dispose();
});

function Probe({ id, atPresent }: { id: ConversationId; atPresent: boolean }) {
  useReadTracking(id, atPresent);
  return null;
}

async function setup() {
  const shrike = await bootShrike();
  shrikes.push(shrike);
  const id = Object.keys(shrike.stores.conversations.getState().byId)[0] as ConversationId;
  act(() => {
    shrike.stores.ui.getState().selectConversation(id);
    shrike.stores.conversations.getState().setUnread(id, { count: 3, mentions: 0 });
  });
  const markRead = vi.spyOn(shrike.sync, 'markConversationRead').mockResolvedValue();
  return { shrike, id, markRead };
}

describe('useReadTracking', () => {
  it('does not mark read while the newest message is off screen, and says so to the sync engine', async () => {
    const { shrike, id, markRead } = await setup();
    act(() => {
      shrike.stores.ui.getState().setWindowFocused(true);
    });
    renderWithShrike(shrike, <Probe id={id} atPresent={false} />);
    expect(markRead).not.toHaveBeenCalled();
    expect(shrike.stores.ui.getState().scrolledUp[id]).toBe(true);
  });

  it('marks read when the bottom is visible and the window has focus', async () => {
    const { shrike, id, markRead } = await setup();
    act(() => {
      shrike.stores.ui.getState().setWindowFocused(true);
    });
    renderWithShrike(shrike, <Probe id={id} atPresent />);
    expect(markRead).toHaveBeenCalledWith(id);
    expect(shrike.stores.ui.getState().scrolledUp[id]).toBeUndefined();
  });

  it('waits for focus when the window is in the background', async () => {
    const { shrike, id, markRead } = await setup();
    act(() => {
      shrike.stores.ui.getState().setWindowFocused(false);
    });
    renderWithShrike(shrike, <Probe id={id} atPresent />);
    expect(markRead).not.toHaveBeenCalled();
    act(() => {
      shrike.stores.ui.getState().setWindowFocused(true);
    });
    expect(markRead).toHaveBeenCalledWith(id);
  });
});
