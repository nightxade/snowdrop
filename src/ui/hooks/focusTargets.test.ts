import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationId } from '@/core/domain';
import {
  conversationFocusTarget,
  focusConversation,
  followConversationFocus,
  followConversationOpenFocus,
  setConversationFocusPolicy,
  setConversationFocusResolver,
  setConversationListFocusResolver,
} from './focusTargets';

const id = 'conv-1' as ConversationId;
const otherId = 'conv-2' as ConversationId;

/** Waits for the next animation frame (focusConversation/followConversationFocus defer through one). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame();
}

function makeFocusable(): HTMLElement {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
}

function makeSidebarRow(convId: ConversationId): HTMLElement {
  const sidebar =
    document.querySelector<HTMLElement>('[data-snowdrop="sidebar"]') ??
    (() => {
      const el = document.createElement('div');
      el.setAttribute('data-snowdrop', 'sidebar');
      document.body.appendChild(el);
      return el;
    })();
  const row = document.createElement('button');
  row.setAttribute('data-roving-item', '');
  row.setAttribute('data-conversation-id', convId);
  sidebar.appendChild(row);
  return row;
}

describe('focusTargets', () => {
  const unregisters: (() => void)[] = [];

  afterEach(() => {
    for (const fn of unregisters.splice(0)) fn();
    document.body.innerHTML = '';
  });

  describe('conversationFocusTarget', () => {
    it('defaults to the list resolver, falling back to the composer, then the sidebar row', () => {
      const row = makeSidebarRow(id);
      expect(conversationFocusTarget(id)).toBe(row);

      const composerEl = makeFocusable();
      unregisters.push(setConversationFocusResolver((i) => (i === id ? composerEl : null)));
      expect(conversationFocusTarget(id)).toBe(composerEl);

      const listEl = makeFocusable();
      unregisters.push(setConversationListFocusResolver((i) => (i === id ? listEl : null)));
      expect(conversationFocusTarget(id)).toBe(listEl);
    });

    it('prefers the composer when preferComposer is set, falling back to the list', () => {
      const composerEl = makeFocusable();
      const listEl = makeFocusable();
      unregisters.push(setConversationFocusResolver((i) => (i === id ? composerEl : null)));
      unregisters.push(setConversationListFocusResolver((i) => (i === id ? listEl : null)));
      expect(conversationFocusTarget(id, true)).toBe(composerEl);
      expect(conversationFocusTarget(id, false)).toBe(listEl);

      // Composer not mounted for this id: falls back to the list even with preferComposer.
      expect(conversationFocusTarget(otherId, true)).toBeNull();
    });

    it('never returns null when a sidebar row exists, even with no resolvers registered', () => {
      const row = makeSidebarRow(id);
      expect(conversationFocusTarget(id)).toBe(row);
      expect(conversationFocusTarget(id, true)).toBe(row);
    });
  });

  describe('focusConversation', () => {
    it('focuses the resolved target on the next frame', async () => {
      const listEl = makeFocusable();
      unregisters.push(setConversationListFocusResolver((i) => (i === id ? listEl : null)));
      focusConversation(id);
      expect(document.activeElement).not.toBe(listEl);
      await nextFrame();
      expect(document.activeElement).toBe(listEl);
    });

    it('focuses the composer when preferComposer is true', async () => {
      const composerEl = makeFocusable();
      unregisters.push(setConversationFocusResolver((i) => (i === id ? composerEl : null)));
      focusConversation(id, true);
      await nextFrame();
      expect(document.activeElement).toBe(composerEl);
    });
  });

  describe('followConversationFocus', () => {
    it('from a sidebar row, follows to the new row', async () => {
      const before = makeSidebarRow(id);
      before.focus();
      expect(document.activeElement).toBe(before);
      const after = makeSidebarRow(otherId);
      const follow = followConversationFocus();
      follow(otherId);
      await nextFrame();
      expect(document.activeElement).toBe(after);
    });

    it('from anywhere else, lands on the list by default', async () => {
      const notARow = makeFocusable();
      notARow.focus();
      const listEl = makeFocusable();
      unregisters.push(setConversationListFocusResolver((i) => (i === otherId ? listEl : null)));
      const follow = followConversationFocus();
      follow(otherId);
      await nextFrame();
      expect(document.activeElement).toBe(listEl);
    });

    it('from anywhere else, lands on the composer when preferComposer is set', async () => {
      const notARow = makeFocusable();
      notARow.focus();
      const composerEl = makeFocusable();
      unregisters.push(setConversationFocusResolver((i) => (i === otherId ? composerEl : null)));
      const follow = followConversationFocus(true);
      follow(otherId);
      await nextFrame();
      expect(document.activeElement).toBe(composerEl);
    });

    it('never leaves focus on <body> when the old target is gone', async () => {
      const before = makeSidebarRow(id);
      before.focus();
      before.remove(); // the switch unmounted the old row
      const listEl = makeFocusable();
      unregisters.push(setConversationListFocusResolver((i) => (i === otherId ? listEl : null)));
      const follow = followConversationFocus();
      follow(otherId);
      await nextFrame();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(listEl);
    });
  });

  describe('followConversationOpenFocus', () => {
    it('is a no-op when no focus policy is active', async () => {
      const before = makeFocusable();
      before.focus();
      const listEl = makeFocusable();
      unregisters.push(setConversationListFocusResolver((i) => (i === id ? listEl : null)));
      followConversationOpenFocus(id);
      await frames(6);
      expect(document.activeElement).toBe(before);
    });

    it('a pointer open moves focus to the list once a policy is active', async () => {
      unregisters.push(setConversationFocusPolicy(() => true));
      const listEl = makeFocusable();
      unregisters.push(setConversationListFocusResolver((i) => (i === id ? listEl : null)));
      followConversationOpenFocus(id);
      await frames(1);
      expect(document.activeElement).toBe(listEl);
    });

    it('retries a few frames before falling back, when the list has not rendered a row yet', async () => {
      unregisters.push(setConversationFocusPolicy(() => true));
      let calls = 0;
      const listEl = makeFocusable();
      unregisters.push(
        setConversationListFocusResolver((i) => {
          if (i !== id) return null;
          calls += 1;
          // Not mounted on the first couple of frames (Virtuoso hasn't rendered rows yet).
          return calls >= 3 ? listEl : null;
        }),
      );
      followConversationOpenFocus(id);
      await frames(1);
      expect(document.activeElement).not.toBe(listEl); // too soon — still retrying
      await frames(4);
      expect(document.activeElement).toBe(listEl);
      expect(calls).toBeGreaterThanOrEqual(3);
    });

    it('falls back to the sidebar row if the list never renders within the retry window', async () => {
      unregisters.push(setConversationFocusPolicy(() => true));
      const row = makeSidebarRow(id);
      unregisters.push(setConversationListFocusResolver(() => null));
      followConversationOpenFocus(id);
      await frames(8);
      expect(document.activeElement).toBe(row);
    });

    it('never steals focus from an overlay or a text input', async () => {
      unregisters.push(setConversationFocusPolicy(() => true));
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      const listEl = makeFocusable();
      unregisters.push(setConversationListFocusResolver((i) => (i === id ? listEl : null)));
      followConversationOpenFocus(id);
      await frames(6);
      expect(document.activeElement).toBe(input);
      input.remove();
    });
  });
});
