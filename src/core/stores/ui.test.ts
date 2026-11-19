import { describe, expect, it } from 'vitest';
import type { MessageId } from '@/core/domain';
import { conversationIdFor } from '@/core/domain/testing';
import { createUiStore, HOME, MAX_TOASTS, uiSelectors } from './ui';

describe('uiStore', () => {
  it('remembers the selected conversation per space', () => {
    const store = createUiStore();
    const a = conversationIdFor('a');
    const b = conversationIdFor('b');
    store.getState().selectConversation(a);
    store.getState().selectConversation(b, 'space-1');
    expect(uiSelectors.selectedConversation(store.getState())).toBe(b);
    store.getState().selectSpace(HOME);
    expect(uiSelectors.selectedConversation(store.getState())).toBe(a);
  });

  it('caps the toast queue', () => {
    let n = 0;
    const store = createUiStore(() => `t${++n}`);
    for (let i = 0; i < MAX_TOASTS + 2; i++)
      store.getState().pushToast({ message: `m${i}`, kind: 'info', source: 'core' });
    expect(store.getState().toasts).toHaveLength(MAX_TOASTS);
    expect(store.getState().toasts[0]?.message).toBe('m2');
    store.getState().dismissToast('t3');
    expect(store.getState().toasts.map((t) => t.id)).toEqual(['t4', 't5', 't6']);
  });

  it('gives every edit of the same message a session of its own', () => {
    const ui = createUiStore();
    const target = {
      conversationId: conversationIdFor('a'),
      messageId: 'm-1' as MessageId,
    };
    ui.getState().setEditing(target);
    const first = ui.getState().editing?.session;
    ui.getState().setEditing(null);
    ui.getState().setEditing(target);
    const second = ui.getState().editing?.session;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // A caller that passes its session keeps it.
    ui.getState().setEditing({ ...target, session: second! });
    expect(ui.getState().editing?.session).toBe(second);
  });

  describe('an edit left behind by switching chats', () => {
    const a = conversationIdFor('a');
    const b = conversationIdFor('b');
    const target = { conversationId: a, messageId: 'm-1' as MessageId };

    it('comes back with its text when its chat is opened again', () => {
      const ui = createUiStore();
      ui.getState().selectConversation(a);
      ui.getState().setEditing(target);
      ui.getState().setEditDraft('typed so far');
      ui.getState().setEditMentions([{ id: 'x', label: '@X' }]);
      const before = ui.getState().editing?.session;
      ui.getState().selectConversation(b);
      expect(ui.getState().editing).toBeNull();
      ui.getState().selectConversation(a);
      expect(ui.getState().editing).toMatchObject({
        messageId: 'm-1',
        draft: 'typed so far',
        mentions: [{ id: 'x', label: '@X' }],
      });
      // A new session, so the editor takes focus again.
      expect(ui.getState().editing?.session).not.toBe(before);
      expect(ui.getState().parkedEdits).toEqual({});
    });

    it('is dropped when nothing was typed, and stays when the same chat is opened again', () => {
      const ui = createUiStore();
      ui.getState().selectConversation(a);
      ui.getState().setEditing(target);
      ui.getState().selectConversation(a);
      expect(ui.getState().editing).toMatchObject({ messageId: 'm-1' });
      ui.getState().selectConversation(b);
      ui.getState().selectConversation(a);
      expect(ui.getState().editing).toBeNull();
    });
  });
});
