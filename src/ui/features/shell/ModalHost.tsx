import { lazy, Suspense } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import {
  CategoryDialog,
  CreateSpaceDialog,
  DeleteSpaceDialog,
  EditFolderDialog,
  EditSpaceDialog,
} from '@/ui/features/spaces';
import { QuickSwitcher } from '@/ui/features/switcher';
import { SettingsFallback } from './SettingsFallback';
import { ShortcutsDialog } from './ShortcutsDialog';

// Kept out of the main chunk: settings are opened rarely and are the largest UI.
const SettingsOverlay = lazy(() =>
  import('@/ui/features/settings').then((m) => ({ default: m.SettingsOverlay })),
);

function stringProp(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === 'string' ? value : undefined;
}

function pageProp(props: Record<string, unknown> | undefined): { initialPage?: string } {
  const page = stringProp(props, 'page');
  return page ? { initialPage: page } : {};
}

/** Renders the one open modal from `uiStore.modal` (commands and plugins open them by type). */
export function ModalHost() {
  const stores = useStores();
  const modal = useStore(stores.ui, uiSelectors.modal);
  if (!modal) return null;
  const close = () => {
    stores.ui.getState().closeModal();
  };
  switch (modal.type) {
    case 'switcher':
      return <QuickSwitcher onClose={close} />;
    case 'settings':
      return (
        <Suspense fallback={<SettingsFallback />}>
          <SettingsOverlay onClose={close} {...pageProp(modal.props)} />
        </Suspense>
      );
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />;
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
