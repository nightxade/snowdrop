import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import type { ConversationId, MessageId } from '@/core/domain';
import { BlockDialog, type GroupMemberAction } from '@/ui/features/conversation';
import { uiSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { OpenerHostProvider, type OpenerHost } from '@/ui/primitives';
import { SettingsFallback } from './SettingsFallback';

// The switcher (with cmdk) is its own chunk, prefetched once the app is idle so
// Ctrl+K never waits on the network.
const loadSwitcher = () => import('@/ui/features/switcher');
const QuickSwitcher = lazy(() => loadSwitcher().then((m) => ({ default: m.QuickSwitcher })));

// Kept out of the main chunk: settings are opened rarely and are the largest UI.
const SettingsOverlay = lazy(() =>
  import('@/ui/features/settings').then((m) => ({ default: m.SettingsOverlay })),
);

// All-chats search: opened by its shortcut and the sidebar button; prefetched with the switcher.
const loadSearch = () => import('@/ui/features/search');
const GlobalSearch = lazy(() => loadSearch().then((m) => ({ default: m.GlobalSearch })));

// New message: opened from the Home sidebar and the palette; prefetched with the switcher.
const loadNewChat = () => import('@/ui/features/newChat');
const NewMessageDialog = lazy(() => loadNewChat().then((m) => ({ default: m.NewMessageDialog })));

// Forward to: opened from a message's menu; prefetched with the switcher.
const loadForward = () => import('@/ui/features/forward');
const ForwardDialog = lazy(() => loadForward().then((m) => ({ default: m.ForwardDialog })));

// Safety number viewer and the "Safety Number Changes" dialog: opened from menus, system lines
// and a send that a changed safety number stopped; prefetched with the rest.
const loadSafety = () => import('@/ui/features/safety');
const SafetyNumberDialog = lazy(() =>
  loadSafety().then((m) => ({ default: m.SafetyNumberDialog })),
);
const SafetyNumberChangeDialog = lazy(() =>
  loadSafety().then((m) => ({ default: m.SafetyNumberChangeDialog })),
);

// Group dialogs (edit, add members, link, permissions, leave, new group): opened from the
// chat header, the member list and New message; prefetched with the rest.
const loadGroups = () => import('@/ui/features/groups');
const NewGroupDialog = lazy(() => loadGroups().then((m) => ({ default: m.NewGroupDialog })));
const EditGroupDialog = lazy(() => loadGroups().then((m) => ({ default: m.EditGroupDialog })));
const AddMembersDialog = lazy(() => loadGroups().then((m) => ({ default: m.AddMembersDialog })));
const GroupLinkDialog = lazy(() => loadGroups().then((m) => ({ default: m.GroupLinkDialog })));
const PermissionsDialog = lazy(() => loadGroups().then((m) => ({ default: m.PermissionsDialog })));
const LeaveGroupDialog = lazy(() => loadGroups().then((m) => ({ default: m.LeaveGroupDialog })));
const MemberActionDialog = lazy(() =>
  loadGroups().then((m) => ({ default: m.MemberActionDialog })),
);

// Space/folder/category dialogs and the shortcut sheet: small, but opened rarely.
// Prefetched with the switcher so opening one doesn't wait on the network.
const loadSpaces = () => import('@/ui/features/spaces');
const CreateSpaceDialog = lazy(() => loadSpaces().then((m) => ({ default: m.CreateSpaceDialog })));
const EditSpaceDialog = lazy(() => loadSpaces().then((m) => ({ default: m.EditSpaceDialog })));
const DeleteSpaceDialog = lazy(() => loadSpaces().then((m) => ({ default: m.DeleteSpaceDialog })));
const EditFolderDialog = lazy(() => loadSpaces().then((m) => ({ default: m.EditFolderDialog })));
const CategoryDialog = lazy(() => loadSpaces().then((m) => ({ default: m.CategoryDialog })));
const loadShortcuts = () => import('./ShortcutsDialog');
const ShortcutsDialog = lazy(() => loadShortcuts().then((m) => ({ default: m.ShortcutsDialog })));

// Sign out/leave demo/disconnect: opened from the user panel's menu and the
// command palette. Shares the settings chunk (architecture boundary: a
// feature is reached only through its index.ts) — same chunk ConnectionPage
// renders it from, so this never pulls in anything extra.
const SignOutDialog = lazy(() =>
  import('@/ui/features/settings').then((m) => ({ default: m.SignOutDialog })),
);

function stringProp(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === 'string' ? value : undefined;
}

const MEMBER_ACTIONS: readonly GroupMemberAction[] = [
  'remove',
  'make-admin',
  'remove-admin',
  'approve',
  'deny',
  'revoke',
];

function conversationProp(props: Record<string, unknown> | undefined): ConversationId | undefined {
  return stringProp(props, 'conversationId') as ConversationId | undefined;
}

function pageProp(props: Record<string, unknown> | undefined): { initialPage?: string } {
  const page = stringProp(props, 'page');
  return page ? { initialPage: page } : {};
}

/** The Suspense fallback: marks the host as waiting, so hidden layers aren't taken for gone ones. */
function Pending({
  onChange,
  children,
}: {
  onChange: (pending: boolean) => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    onChange(true);
    return () => {
      onChange(false);
    };
  }, [onChange]);
  return children;
}

/** Renders nothing; its effect runs once the dialog beside it has mounted (see `ModalHost`). */
function Mounted({ onMounted }: { onMounted: () => void }) {
  useEffect(() => {
    onMounted();
  }, [onMounted]);
  return null;
}

/**
 * Renders the one open modal from `uiStore.modal` (commands and plugins open them by type).
 *
 * It also owns what every dialog needs from the chain of dialogs it shows:
 * - the opener: whatever had focus when the first one was requested. A dialog that
 *   replaces another (or swaps its own view) leaves it alone, and focus goes back
 *   there only when the last one closes;
 * - closing a dialog whose subject is gone: one that renders nothing (the group was
 *   removed, a bad id) would otherwise leave `ui.modal` set with nothing on screen,
 *   which switches the global shortcuts off.
 */
export function ModalHost() {
  const stores = useStores();
  const modal = useStore(stores.ui, uiSelectors.modal);
  const opener = useRef<HTMLElement | null>(null);
  /** Recently focused elements, oldest first: where focus was before a menu or palette took it. */
  const history = useRef<HTMLElement[]>([]);
  const layers = useRef(0);
  /** A Suspense fallback is showing (the dialog's layers are hidden, not gone). */
  const suspended = useRef(false);
  const setSuspended = useCallback((pending: boolean) => {
    suspended.current = pending;
  }, []);
  /** The key of the modal whose dialog has rendered at least once. */
  const resolvedKey = useRef<string | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || el === document.body) return;
      history.current = [...history.current.filter((x) => x !== el), el].slice(-12);
    };
    document.addEventListener('focusin', onFocusIn, true);
    const pending = timers.current;
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);
  useEffect(
    () =>
      // Synchronously with the request, while the opener still has focus.
      stores.ui.subscribe((state, previous) => {
        if (state.modal && !previous.modal) {
          const el = document.activeElement;
          opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
        }
      }),
    [stores],
  );
  const host = useMemo<OpenerHost>(() => {
    const closeIfEmpty = () => {
      const current = stores.ui.getState().modal;
      if (
        current &&
        !suspended.current &&
        resolvedKey.current === modalKey(current) &&
        layers.current === 0
      ) {
        stores.ui.getState().closeModal();
      }
    };
    return {
      // The recorded opener, unless it is gone (a palette or menu item that opened the dialog
      // closes with it): then what had focus before that, which is never the page body.
      opener: () => {
        if (opener.current?.isConnected) return opener.current;
        for (const el of [...history.current].reverse()) {
          if (el.isConnected && !el.closest('[role="dialog"], [role="menu"]')) return el;
        }
        return document.querySelector<HTMLElement>(
          '[data-snowdrop="composer-input"], [data-snowdrop="message-log"]',
        );
      },
      settled: () => stores.ui.getState().modal === null,
      register: () => {
        layers.current += 1;
        return () => {
          layers.current -= 1;
          // After the commit: a dialog swapping for another has mounted its layer by then.
          const timer = setTimeout(() => {
            timers.current.delete(timer);
            closeIfEmpty();
          }, 0);
          timers.current.add(timer);
        };
      },
    };
  }, [stores]);
  const onMounted = useMemo(
    () => () => {
      const current = stores.ui.getState().modal;
      resolvedKey.current = current ? modalKey(current) : null;
      if (layers.current === 0) stores.ui.getState().closeModal();
    },
    [stores],
  );
  useEffect(() => {
    const prefetch = () => {
      void loadSwitcher();
      void loadSearch();
      void loadNewChat();
      void loadForward();
      void loadGroups();
      void loadSafety();
      void loadSpaces();
      void loadShortcuts();
    };
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(prefetch);
      return () => {
        window.cancelIdleCallback(handle);
      };
    }
    const timer = setTimeout(prefetch, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  if (!modal) return null;
  const close = () => {
    stores.ui.getState().closeModal();
  };
  return (
    <OpenerHostProvider value={host}>
      <Suspense
        fallback={
          <Pending onChange={setSuspended}>
            {modal.type === 'settings' || modal.type === 'signOut' ? <SettingsFallback /> : null}
          </Pending>
        }
      >
        {/* The same type with other props is another dialog, not an update of this one. */}
        <Fragment key={modalKey(modal)}>
          {modalElement(modal, close)}
          <Mounted onMounted={onMounted} />
        </Fragment>
      </Suspense>
    </OpenerHostProvider>
  );
}

type Modal = NonNullable<ReturnType<typeof uiSelectors.modal>>;

function modalKey(modal: Modal): string {
  try {
    return `${modal.type}:${JSON.stringify(modal.props ?? null)}`;
  } catch {
    return modal.type;
  }
}

function modalElement(modal: Modal, close: () => void) {
  switch (modal.type) {
    case 'switcher':
      return <QuickSwitcher onClose={close} initialQuery={stringProp(modal.props, 'query')} />;
    case 'searchAll':
      return <GlobalSearch onClose={close} />;
    case 'newMessage':
      return <NewMessageDialog onClose={close} />;
    case 'forward': {
      const conversationId = conversationProp(modal.props);
      const ids = modal.props?.messageIds;
      const messageIds = Array.isArray(ids)
        ? ids.filter((x): x is MessageId => typeof x === 'string')
        : [];
      return conversationId && messageIds.length > 0 ? (
        <ForwardDialog conversationId={conversationId} messageIds={messageIds} onClose={close} />
      ) : null;
    }
    case 'blockConversation': {
      const conversationId = conversationProp(modal.props);
      return conversationId ? (
        <BlockDialog
          conversationId={conversationId}
          unblock={modal.props?.unblock === true}
          onClose={close}
        />
      ) : null;
    }
    case 'safetyNumber': {
      const contactId = stringProp(modal.props, 'contactId');
      return contactId ? <SafetyNumberDialog contactId={contactId} onClose={close} /> : null;
    }
    case 'safetyNumberChange': {
      const conversationId = conversationProp(modal.props);
      const nonce = stringProp(modal.props, 'nonce');
      const ids = modal.props?.contactIds;
      const contactIds = Array.isArray(ids)
        ? ids.filter((x): x is string => typeof x === 'string')
        : [];
      return conversationId && nonce && contactIds.length > 0 ? (
        <SafetyNumberChangeDialog
          conversationId={conversationId}
          nonce={nonce}
          contactIds={contactIds}
          onClose={close}
        />
      ) : null;
    }
    case 'newGroup':
      return <NewGroupDialog onClose={close} />;
    case 'editGroup':
    case 'addMembers':
    case 'groupLink':
    case 'groupPermissions':
    case 'leaveGroup':
    case 'groupMemberAction':
      return groupElement(modal, close);
    case 'settings':
      return <SettingsOverlay onClose={close} {...pageProp(modal.props)} />;
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />;
    case 'signOut':
      return <SignOutDialog onClose={close} />;
    case 'createSpace': {
      const ids = modal.props?.conversationIds;
      const conversationIds = Array.isArray(ids)
        ? ids.filter((x): x is ConversationId => typeof x === 'string')
        : [];
      return <CreateSpaceDialog conversationIds={conversationIds} onClose={close} />;
    }
    case 'editSpace': {
      const spaceId = stringProp(modal.props, 'spaceId');
      return spaceId ? <EditSpaceDialog spaceId={spaceId} onClose={close} /> : null;
    }
    case 'deleteSpace': {
      const spaceId = stringProp(modal.props, 'spaceId');
      return spaceId ? <DeleteSpaceDialog spaceId={spaceId} onClose={close} /> : null;
    }
    case 'editFolder': {
      const folderId = stringProp(modal.props, 'folderId');
      return folderId ? <EditFolderDialog folderId={folderId} onClose={close} /> : null;
    }
    case 'category': {
      const spaceId = stringProp(modal.props, 'spaceId');
      return spaceId ? (
        <CategoryDialog
          spaceId={spaceId}
          categoryId={stringProp(modal.props, 'categoryId')}
          onClose={close}
        />
      ) : null;
    }
    default:
      return null;
  }
}

/** The dialogs about one group: they all need its id (and a member and action for the last). */
function groupElement(modal: Modal, close: () => void) {
  const conversationId = conversationProp(modal.props);
  if (!conversationId) return null;
  switch (modal.type) {
    case 'editGroup':
      return <EditGroupDialog conversationId={conversationId} onClose={close} />;
    case 'addMembers':
      return <AddMembersDialog conversationId={conversationId} onClose={close} />;
    case 'groupLink':
      return <GroupLinkDialog conversationId={conversationId} onClose={close} />;
    case 'groupPermissions':
      return <PermissionsDialog conversationId={conversationId} onClose={close} />;
    case 'leaveGroup':
      return <LeaveGroupDialog conversationId={conversationId} onClose={close} />;
    case 'groupMemberAction': {
      const memberId = stringProp(modal.props, 'memberId');
      const action = MEMBER_ACTIONS.find((a) => a === stringProp(modal.props, 'action'));
      return memberId && action ? (
        <MemberActionDialog
          conversationId={conversationId}
          memberId={memberId}
          action={action}
          onClose={close}
        />
      ) : null;
    }
    default:
      return null;
  }
}
