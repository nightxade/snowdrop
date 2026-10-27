import { lazy, Suspense, useEffect } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, MessageId } from '@/core/domain';
import { BlockDialog, type GroupMemberAction } from '@/ui/features/conversation';
import { uiSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
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

/** Renders the one open modal from `uiStore.modal` (commands and plugins open them by type). */
export function ModalHost() {
  const stores = useStores();
  const modal = useStore(stores.ui, uiSelectors.modal);
  useEffect(() => {
    const prefetch = () => {
      void loadSwitcher();
      void loadSearch();
      void loadNewChat();
      void loadForward();
      void loadGroups();
      void loadSpaces();
      void loadShortcuts();
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(prefetch);
    else setTimeout(prefetch, 1500);
  }, []);
  if (!modal) return null;
  const close = () => {
    stores.ui.getState().closeModal();
  };
  return (
    <Suspense
      fallback={modal.type === 'settings' || modal.type === 'signOut' ? <SettingsFallback /> : null}
    >
      {modalElement(modal, close)}
    </Suspense>
  );
}

type Modal = NonNullable<ReturnType<typeof uiSelectors.modal>>;

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
