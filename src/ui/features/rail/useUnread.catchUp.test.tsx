/**
 * The rail's unread follows the sidebar's catch-up hold (S1): while catching up a tile does not
 * light for what the held list does not show; a chat the user marks as read is held at nothing at
 * once; the live state is back when the catch-up ends.
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import type { Snowdrop } from '@/app/createSnowdrop';
import { directConversationId } from '@/core/domain';
import { makeConversation } from '@/core/domain/testing';
import { SpaceTile } from './SpaceTile';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

async function boot() {
  snowdrop = await bootSnowdrop();
  const stores = snowdrop.stores;
  const selfId = stores.session.getState().self?.id;
  if (!selfId) throw new Error('no self id after boot');
  const ana = directConversationId('ana');
  stores.local.getState().markAccepted(ana, 0);
  act(() => {
    stores.conversations.getState().upsert(
      makeConversation({
        id: ana,
        kind: 'direct',
        title: 'Ana',
        memberIds: [selfId, 'ana'],
        lastActivityAt: 1000,
      }),
    );
  });
  const space = stores.spaces.getState().createSpace({ name: 'Trips', conversationIds: [ana] });
  renderWithSnowdrop(snowdrop, <SpaceTile spaceId={space} />);
  await settle(snowdrop);
  const label = () => screen.getByRole('button', { name: /^Trips/ }).getAttribute('aria-label');
  return { stores, ana, label };
}

describe('the rail while catching up', () => {
  it('does not light a tile for what arrives during the hold, then follows the live state', async () => {
    const { stores, ana, label } = await boot();
    expect(label()).toBe('Trips');
    act(() => {
      stores.session.getState().setCatchingUp(true);
    });
    await settle(snowdrop!);
    act(() => {
      stores.conversations.getState().setUnread(ana, { count: 2, mentions: 0 });
    });
    await settle(snowdrop!);
    expect(label()).toBe('Trips');
    act(() => {
      stores.session.getState().setCatchingUp(false);
    });
    await settle(snowdrop!);
    expect(label()).toBe('Trips, unread');
  });

  it('keeps a held unread lit, and clears it at once for a chat marked as read', async () => {
    const { stores, ana, label } = await boot();
    act(() => {
      stores.conversations.getState().setUnread(ana, { count: 1, mentions: 0 });
    });
    await settle(snowdrop!);
    expect(label()).toBe('Trips, unread');
    act(() => {
      stores.session.getState().setCatchingUp(true);
    });
    await settle(snowdrop!);
    expect(label()).toBe('Trips, unread');
    // What the user reads is cleared at once, and what arrives after stays held.
    act(() => {
      stores.session.getState().releaseHeld([ana]);
      stores.conversations.getState().setUnread(ana, { count: 0, mentions: 0 });
    });
    await settle(snowdrop!);
    expect(label()).toBe('Trips');
    act(() => {
      stores.conversations.getState().setUnread(ana, { count: 3, mentions: 0 });
    });
    await settle(snowdrop!);
    expect(label()).toBe('Trips');
    act(() => {
      stores.session.getState().setCatchingUp(false);
    });
    await settle(snowdrop!);
    expect(label()).toBe('Trips, unread');
    expect(stores.session.getState().heldReleased).toEqual([]);
  });
});
