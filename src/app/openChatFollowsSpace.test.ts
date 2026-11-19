import { describe, expect, it } from 'vitest';
import { makeConversation } from '@/core/domain/testing';
import { createStores, HOME } from '@/core/stores';
import { openChatFollowsSpace } from './openChatFollowsSpace';

function setup() {
  const stores = createStores();
  const group = makeConversation({ id: 'group:g' as never, kind: 'group', title: 'G' });
  const direct = makeConversation({ id: 'direct:d' as never, kind: 'direct', title: 'D' });
  stores.conversations.getState().upsertMany([group, direct]);
  const first = stores.spaces
    .getState()
    .createSpace({ name: 'First', conversationIds: [group.id] });
  const second = stores.spaces.getState().createSpace({ name: 'Second' });
  const off = openChatFollowsSpace(stores);
  const selected = (space: string) => stores.ui.getState().selectedConversationBySpace[space];
  return { stores, group, direct, first, second, off, selected };
}

describe('the open chat follows its space', () => {
  it('stays open where the user is when it moves, and is selected in the space it moved to', () => {
    const { stores, group, first, second, selected } = setup();
    stores.ui.getState().selectConversation(group.id, first);
    stores.spaces.getState().assign(group.id, second);
    // Still open in the space the user is viewing, and open in the new one too.
    expect(stores.ui.getState().selectedSpace).toBe(first);
    expect(selected(first)).toBe(group.id);
    expect(selected(second)).toBe(group.id);
    stores.spaces.getState().unassign(group.id);
    expect(stores.ui.getState().selectedSpace).toBe(first);
    expect(selected(HOME)).toBe(group.id);
  });

  it('does nothing for a chat that is not open, a direct chat, or a move within the same space', () => {
    const { stores, group, direct, first, second, selected } = setup();
    stores.spaces.getState().assign(group.id, second);
    expect(selected(second)).toBeUndefined();
    stores.ui.getState().selectConversation(direct.id, HOME);
    stores.spaces.getState().assign(direct.id, first);
    expect(selected(first)).toBeUndefined();
    stores.ui.getState().selectConversation(group.id, second);
    const addedCategory = stores.spaces.getState().addCategory(second, 'More');
    stores.spaces.getState().moveConversation(group.id, addedCategory!, 0);
    expect(selected(HOME)).toBe(direct.id);
    expect(selected(first)).toBeUndefined();
  });

  it('stops following once unsubscribed', () => {
    const { stores, group, first, second, off, selected } = setup();
    stores.ui.getState().selectConversation(group.id, first);
    off();
    stores.spaces.getState().assign(group.id, second);
    expect(selected(second)).toBeUndefined();
  });
});
