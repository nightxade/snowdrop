import { useEffect } from 'react';
import { useStore } from 'zustand';
import { HOME, sessionSelectors, uiSelectors } from '@/core/stores';
import { useHearth } from '@/ui/hooks';

/**
 * Side effects of navigation, in one place so every path (click, keyboard,
 * switcher, plugin) behaves the same:
 * - opening a conversation loads its history (HistoryService.open snapshots
 *   the unread marker first) and marks it read while the window has focus;
 * - window focus is mirrored into the ui store (SyncService only auto-reads
 *   incoming messages for a focused, open conversation);
 * - a deleted space falls back to Home.
 */
export function useConversationLifecycle(): void {
  const { stores, history, sync } = useHearth();
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const ready = useStore(stores.session, sessionSelectors.ready);
  const focused = useStore(stores.ui, (s) => s.windowFocused);
  const space = useStore(stores.ui, uiSelectors.selectedSpace);
  const spaceExists = useStore(stores.spaces, (s) => space === HOME || space in s.spaces);

  useEffect(() => {
    if (!selected || !ready) return;
    let cancelled = false;
    void history.open(selected).then(() => {
      // P3's message list will refine this to "read when scrolled to the bottom".
      if (!cancelled && stores.ui.getState().windowFocused)
        void sync.markConversationRead(selected);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, ready, history, sync, stores]);

  // Coming back to the window reads what arrived while away.
  useEffect(() => {
    if (focused && selected && ready) void sync.markConversationRead(selected);
  }, [focused, selected, ready, sync]);

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
