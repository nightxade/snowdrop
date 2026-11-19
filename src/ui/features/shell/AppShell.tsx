import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import {
  conversationFocusTarget,
  ShellLayoutProvider,
  useBelowBreakpoint,
  useHandOffWhenGone,
  useShellStyle,
  useStores,
  type ShellLayout,
} from '@/ui/hooks';
import { ChatColumn } from '@/ui/features/chat';
import { Rail } from '@/ui/features/rail';
import { Sidebar } from '@/ui/features/sidebar';
import { AreaErrorBoundary } from '@/ui/lib/AreaErrorBoundary';
import { Drawer, TooltipProvider } from '@/ui/primitives';
import { DemoBanner } from './DemoBanner';
import { ModalHost } from './ModalHost';
import { StatusLine } from './StatusLine';
import { ToastBridge } from './ToastBridge';
import { useConversationLifecycle } from './useConversationLifecycle';
import { useCoreCommands } from './useCoreCommands';
import { useKeyboard } from './useKeyboard';
import styles from './AppShell.module.css';

/** The four-column layout (PLAN §4.1) and its responsive variants. */
export function AppShell() {
  const stores = useStores();
  const tui = useShellStyle();
  const narrow = useBelowBreakpoint('members');
  const drawer = useBelowBreakpoint('drawer');
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const [navOpen, setNavOpen] = useState(() => drawer && selected === null);

  useCoreCommands();
  useKeyboard();
  useConversationLifecycle();
  useMemberSheetPreference(narrow);

  // Picking a conversation from the drawer closes it, including the one that is
  // already open: every pick replaces the map (adjusting state during render,
  // React's recommended alternative to a syncing effect).
  const picks = useStore(stores.ui, (s) => s.selectedConversationBySpace);
  const [lastSeen, setLastSeen] = useState({ selected, picks });
  // The conversation whose pick closed the drawer: focus goes to it (S20), not back to the button.
  const [pickedId, setPickedId] = useState<ConversationId | null>(null);
  if (selected !== lastSeen.selected || picks !== lastSeen.picks) {
    setLastSeen({ selected, picks });
    if (selected) {
      setNavOpen(false);
      if (navOpen) setPickedId(selected);
    }
  }
  if (navOpen && pickedId !== null) setPickedId(null);

  // The drawer only exists in drawer mode: leaving it closes it, so narrowing again never
  // brings it back over the chat.
  if (!drawer && navOpen) setNavOpen(false);

  // The window narrowed and the sidebar went into a closed drawer with focus on a row (or the
  // rail): focus goes to the fallback (the composer), never the page.
  const wasDrawer = useRef(drawer);
  useHandOffWhenGone({
    identify: (el) => (el.closest('[data-shell-nav]') ? 'nav' : null),
    // Only the render that turned the sidebar into a drawer: the drawer hands focus back itself.
    stillThere: () => wasDrawer.current || !drawer || navOpen,
  });
  useLayoutEffect(() => {
    wasDrawer.current = drawer;
  });

  const layout = useMemo<ShellLayout>(
    () => ({ narrow, drawer, navOpen, setNavOpen }),
    [narrow, drawer, navOpen],
  );

  return (
    <ShellLayoutProvider value={layout}>
      <TooltipProvider>
        <div
          className={styles.root}
          data-snowdrop="app"
          data-layout={drawer ? 'drawer' : narrow ? 'narrow' : 'wide'}
        >
          <DemoBanner />
          <div className={styles.shell} data-snowdrop="pane-area">
            {drawer ? (
              <Drawer
                open={navOpen}
                onOpenChange={setNavOpen}
                label="Navigation"
                returnFocus={navToggle}
                closeTarget={() => {
                  if (pickedId === null) return null;
                  const target = conversationFocusTarget(
                    pickedId,
                    stores.settings.getState().behaviour.focusComposerOnOpen,
                  );
                  // The row it falls back to is in the drawer that is going away.
                  return target?.closest('[data-snowdrop="sidebar"]') ? null : target;
                }}
              >
                <div className={styles.nav} data-snowdrop="drawer" data-shell-nav>
                  <Rail />
                  <SidebarArea />
                </div>
              </Drawer>
            ) : (
              <div className={styles.nav} data-shell-nav>
                <Rail />
                <SidebarArea />
              </div>
            )}
            <ChatColumn />
          </div>
          {tui && <StatusLine />}
        </div>
        <ModalHost />
        <ToastBridge />
      </TooltipProvider>
    </ShellLayoutProvider>
  );
}

/** The chat header's hamburger: where focus returns when the navigation drawer closes. */
const navToggle = () =>
  document.querySelector<HTMLElement>(
    '[data-snowdrop="chat-header"] button[aria-label^="Open navigation"]',
  );

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

/** The conversation list: a crash in it leaves the chat and settings usable. */
function SidebarArea() {
  return (
    <AreaErrorBoundary area="the conversation list">
      <Sidebar />
    </AreaErrorBoundary>
  );
}
