/**
 * The chat column contains its own render errors: a crashing message area
 * shows a fallback (and resets on the next conversation), a crashing member
 * panel leaves the rest of the chat standing.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatColumn } from './ChatColumn';

const broken = vi.hoisted(() => ({ area: false, members: false, player: false }));

vi.mock('./ConversationArea', () => ({
  ConversationArea: ({ conversationId }: { conversationId: string }) => {
    if (broken.area) throw new Error('area boom');
    return <p>area {conversationId}</p>;
  },
}));
vi.mock('./voice/MiniPlayer', () => ({
  MiniPlayer: () => {
    if (broken.player) throw new Error('player boom');
    return null;
  },
}));
vi.mock('./ChatHeader', () => ({ ChatHeader: () => <header>stub header</header> }));
vi.mock('@/ui/features/members', () => ({
  MembersPanel: () => {
    if (broken.members) throw new Error('members boom');
    return <p>stub members</p>;
  },
}));

const live: Snowdrop[] = [];
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  broken.area = false;
  broken.members = false;
  broken.player = false;
  cleanup();
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
});

async function mount() {
  const snowdrop = await bootSnowdrop();
  live.push(snowdrop);
  const all = Object.values(snowdrop.stores.conversations.getState().byId);
  const group = all.find((c) => c.kind === 'group')!;
  const other = all.find((c) => c.id !== group.id)!;
  act(() => {
    snowdrop.stores.ui.getState().selectConversation(group.id);
    snowdrop.stores.ui.getState().toggleMemberList(true);
  });
  renderWithSnowdrop(snowdrop, <ChatColumn />);
  await settle(snowdrop);
  return { snowdrop, group: group.id, other: other.id };
}

describe('ChatColumn areas', () => {
  it('a crashing message area shows the chat fallback, and the next conversation resets it', async () => {
    broken.area = true;
    const { snowdrop, other } = await mount();
    expect(screen.getByRole('alert').textContent).toContain('the chat');
    broken.area = false;
    act(() => {
      snowdrop.stores.ui.getState().selectConversation(other);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(`area ${other}`)).toBeTruthy();
  });

  it('Try again re-renders the chat', async () => {
    broken.area = true;
    const { group } = await mount();
    broken.area = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText(`area ${group}`)).toBeTruthy();
  });

  it('a crashing member panel leaves the conversation standing', async () => {
    broken.members = true;
    const { group } = await mount();
    expect(screen.getByRole('alert').textContent).toContain('the members');
    expect(screen.getByText(`area ${group}`)).toBeTruthy();
    expect(screen.getByText('stub header')).toBeTruthy();
  });

  it('a crashing mini player leaves the conversation and header standing', async () => {
    broken.player = true;
    const { group } = await mount();
    expect(screen.getByRole('alert').textContent).toContain('the voice player');
    expect(screen.getByText(`area ${group}`)).toBeTruthy();
    expect(screen.getByText('stub header')).toBeTruthy();
  });
});
