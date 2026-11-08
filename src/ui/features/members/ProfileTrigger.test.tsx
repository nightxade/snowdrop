import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { directConversationId } from '@/core/domain';
import { setConversationListFocusResolver } from '@/ui/hooks';
import { setViewport } from '@/test/bootDemo';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ProfileTrigger } from './ProfileTrigger';

const snowdrops: Snowdrop[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  cleanup();
  for (const undo of cleanups.splice(0)) undo();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

async function openCard(width: number): Promise<{ list: HTMLElement }> {
  setViewport(width);
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const self = snowdrop.stores.session.getState().self!;
  const contact = Object.values(snowdrop.stores.contacts.getState().byId).find(
    (c) => c.id !== self.id && c.isSelf !== true,
  )!;
  // Stands in for the message list of the chat that "Message" opens.
  const list = document.createElement('div');
  list.tabIndex = 0;
  list.setAttribute('data-test-list', '');
  document.body.append(list);
  cleanups.push(
    () => {
      list.remove();
    },
    setConversationListFocusResolver((id) =>
      id === directConversationId(contact.id) ? list : null,
    ),
  );
  renderWithSnowdrop(
    snowdrop,
    <ProfileTrigger contact={contact} trigger={<button type="button">Open card</button>} />,
  );
  await settle(snowdrop);
  const trigger = screen.getByRole('button', { name: 'Open card' });
  act(() => {
    trigger.focus();
    fireEvent.click(trigger);
  });
  return { list };
}

describe('ProfileTrigger: the Message button', () => {
  it('puts focus in the chat it opened, not back on the member row, in a popout', async () => {
    const { list } = await openCard(1440);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Message' }));
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(list);
    });
  });

  it('does the same in the bottom sheet on a phone, and the sheet does not take it back', async () => {
    const { list } = await openCard(500);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Message' }));
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(list);
    });
    // Past the sheet's own focus restore (a frame, then a tick).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(document.activeElement).toBe(list);
  });

  it('still returns focus to the member row when the card is just dismissed', async () => {
    await openCard(1440);
    const trigger = screen.getByRole('button', { name: 'Open card' });
    act(() => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});
