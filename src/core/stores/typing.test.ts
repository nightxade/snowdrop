import { describe, expect, it } from 'vitest';
import { conversationIdFor } from '@/core/domain/testing';
import { createTypingStore, describeTypers, TYPING_TTL_MS, typingSelectors } from './typing';

const conv = conversationIdFor('c');

describe('typingStore', () => {
  it('tracks typers and clears on explicit stop', () => {
    const store = createTypingStore();
    store.getState().setTyping(conv, 'b', true, 0);
    store.getState().setTyping(conv, 'a', true, 0);
    expect(typingSelectors.typers(conv)(store.getState())).toEqual(['a', 'b']);
    store.getState().setTyping(conv, 'a', false, 1);
    expect(typingSelectors.typers(conv)(store.getState())).toEqual(['b']);
  });

  it('expires indicators after the TTL and reports the next expiry', () => {
    const store = createTypingStore();
    store.getState().setTyping(conv, 'a', true, 0);
    store.getState().setTyping(conv, 'b', true, 5_000);
    expect(store.getState().prune(TYPING_TTL_MS - 1)).toBe(TYPING_TTL_MS);
    expect(store.getState().prune(TYPING_TTL_MS)).toBe(5_000 + TYPING_TTL_MS);
    expect(typingSelectors.typers(conv)(store.getState())).toEqual(['b']);
    expect(store.getState().prune(5_000 + TYPING_TTL_MS)).toBeUndefined();
    expect(typingSelectors.typers(conv)(store.getState())).toEqual([]);
  });

  it('refreshes the TTL when typing is re-sent', () => {
    const store = createTypingStore();
    store.getState().setTyping(conv, 'a', true, 0);
    store.getState().setTyping(conv, 'a', true, 10_000);
    store.getState().prune(TYPING_TTL_MS + 1);
    expect(typingSelectors.typers(conv)(store.getState())).toEqual(['a']);
  });

  it('does not churn state for no-op stops or prunes', () => {
    const store = createTypingStore();
    const before = store.getState().byConversation;
    store.getState().setTyping(conv, 'x', false, 0);
    store.getState().prune(0);
    expect(store.getState().byConversation).toBe(before);
  });

  it('describes typers', () => {
    expect(describeTypers([])).toBeNull();
    expect(describeTypers(['Alex'])).toBe('Alex is typing…');
    expect(describeTypers(['Alex', 'Sam'])).toBe('Alex and Sam are typing…');
    expect(describeTypers(['A', 'B', 'C'])).toBe('Several people are typing…');
  });
});
