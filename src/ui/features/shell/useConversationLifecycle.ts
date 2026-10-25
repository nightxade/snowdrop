import { useEffect } from 'react';
import { useStore } from 'zustand';
import { HOME, sessionSelectors, uiSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';

/**
 * Side effects of navigation, in one place so every path (click, keyboard,
 * switcher, plugin) behaves the same:
 * - opening a conversation clears its "marked unread" flag and loads its history (HistoryService.open snapshots
 *   the unread marker first). Marking read is the message list's job: only
 *   when its newest message is on screen and the window has focus;
 * - window focus is mirrored into the ui store (SyncService only auto-reads
 *   incoming messages for a focused, open conversation scrolled to the bottom);
 * - a deleted space falls back to Home.
 */
export function useConversationLifecycle(): void {
  const { stores, history } = useSnowdrop();
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const ready = useStore(stores.session, sessionSelectors.ready);
  const space = useStore(stores.ui, uiSelectors.selectedSpace);
  const spaceExists = useStore(stores.spaces, (s) => space === HOME || space in s.spaces);

  useEffect(() => {
    if (!selected || !ready) return;
    // Opening a conversation clears a hand-set "unread" flag (local only).
    stores.local.getState().setMarkedUnread(selected, false);
    void history.open(selected);
  }, [selected, ready, history, stores]);

  useEffect(() => {
    const update = () => {
      stores.ui.getState().setWindowFocused(document.hasFocus() && !document.hidden);
    };
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [stores]);

  useEffect(() => {
    if (!spaceExists) stores.ui.getState().selectSpace(HOME);
  }, [spaceExists, stores]);
}
