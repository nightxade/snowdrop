import { describe, expect, it } from 'vitest';
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
});
