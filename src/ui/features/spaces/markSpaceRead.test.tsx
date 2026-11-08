import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { AppServices } from '@/ui/hooks';
import { directConversationId } from '@/core/domain';
import { makeConversation } from '@/core/domain/testing';
import { bootSnowdrop } from '@/test/renderWithSnowdrop';
import { markSpaceRead, unreadInSpace } from './useSpaceMenu';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('Mark all as read in a space', () => {
  it('clears every unread chat, archived ones too as Signal Desktop does, but is only offered for chats that count', async () => {
    snowdrop = await bootSnowdrop();
    const { stores } = snowdrop;
    const selfId = stores.session.getState().self!.id;
    const chat = (name: string) => directConversationId(name);
    const names = ['live', 'quiet', 'marked', 'shelved', 'read'];
    let spaceId = '';
    act(() => {
      stores.conversations.getState().upsertMany(
        names.map((name) =>
          makeConversation({
            id: chat(name),
            kind: 'group',
            title: name,
            memberIds: [selfId, name],
            lastActivityAt: 1,
          }),
        ),
      );
      spaceId = stores.spaces.getState().createSpace({
        name: 'Work',
        conversationIds: names.map(chat),
      });
      stores.conversations.getState().setUnread(chat('live'), { count: 2, mentions: 0 });
      stores.conversations.getState().setUnread(chat('quiet'), { count: 3, mentions: 0 });
      stores.local.getState().setMuted(chat('quiet'), true);
      stores.local.getState().setMarkedUnread(chat('marked'), true);
      stores.conversations.getState().setUnread(chat('shelved'), { count: 5, mentions: 0 });
      stores.local.getState().setArchived(chat('shelved'), true);
    });
    const app = snowdrop as unknown as AppServices;
    const read = vi.spyOn(snowdrop.sync, 'markConversationRead').mockResolvedValue(undefined);

    // Offered (enabled) only for chats that can be counted: not the archived one.
    expect(unreadInSpace(app, spaceId)).toEqual([chat('live'), chat('quiet'), chat('marked')]);
    markSpaceRead(app, spaceId);
    expect(read.mock.calls.map(([id]) => id)).toEqual([
      chat('live'),
      chat('quiet'),
      chat('marked'),
      chat('shelved'),
    ]);
  });
});
