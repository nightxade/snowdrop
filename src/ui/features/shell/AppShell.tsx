import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { uiSelectors } from '@/core/stores';
import {
  BREAKPOINTS,
  ShellLayoutProvider,
  useMediaQuery,
  useStores,
  type ShellLayout,
} from '@/ui/hooks';
import { ChatColumn } from '@/ui/features/chat';
import { Rail } from '@/ui/features/rail';
import { Sidebar } from '@/ui/features/sidebar';
import { Drawer, TooltipProvider } from '@/ui/primitives';
import { ModalHost } from './ModalHost';
import { ToastBridge } from './ToastBridge';
import { useConversationLifecycle } from './useConversationLifecycle';
import { useCoreCommands } from './useCoreCommands';
import { useKeyboard } from './useKeyboard';
import styles from './AppShell.module.css';

/** The four-column layout (PLAN §4.1) and its responsive variants. */
export function AppShell() {
  const stores = useStores();
  const narrow = useMediaQuery(BREAKPOINTS.members);
  const drawer = useMediaQuery(BREAKPOINTS.drawer);
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const [navOpen, setNavOpen] = useState(() => drawer && selected === null);

  useCoreCommands();
  useKeyboard();
  useConversationLifecycle();
  useMemberSheetPreference(narrow);

  // Picking a conversation from the drawer closes it (adjusting state during
  // render, React's recommended alternative to a syncing effect).
  const [lastSelected, setLastSelected] = useState(selected);
  if (selected !== lastSelected) {
    setLastSelected(selected);
    if (selected) setNavOpen(false);
  }

  const layout = useMemo<ShellLayout>(
    () => ({ narrow, drawer, navOpen, setNavOpen }),
    [narrow, drawer, navOpen],
  );

  return (
    <ShellLayoutProvider value={layout}>
      <TooltipProvider>
        <div
          className={styles.shell}
          data-hearth="app"
          data-layout={drawer ? 'drawer' : narrow ? 'narrow' : 'wide'}
        >
          {drawer ? (
            <Drawer open={navOpen} onOpenChange={setNavOpen} label="Navigation">
              <div className={styles.nav} data-hearth="drawer">
                <Rail />
                <Sidebar />
              </div>
            </Drawer>
          ) : (
            <div className={styles.nav}>
              <Rail />
              <Sidebar />
            </div>
          )}
          <ChatColumn />
        </div>
        <ModalHost />
        <ToastBridge />
      </TooltipProvider>
    </ShellLayoutProvider>
  );
}

/**
 * Below 1100px the member list is an overlay, so it starts closed there
 * without forgetting that it was open on the wide layout.
 */
function useMemberSheetPreference(narrow: boolean): void {
  const stores = useStores();
  const wideOpen = useRef<boolean | null>(null);
  useEffect(() => {
    const ui = stores.ui.getState();
    if (narrow) {
      wideOpen.current = ui.memberListOpen;
      ui.toggleMemberList(false);
    } else if (wideOpen.current !== null) {
      ui.toggleMemberList(wideOpen.current);
      wideOpen.current = null;
    }
  }, [narrow, stores]);
}
