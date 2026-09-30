import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { CreateSpaceDialog, DeleteSpaceDialog, EditSpaceDialog } from '@/ui/features/spaces';
import { QuickSwitcher } from '@/ui/features/switcher';
import { SettingsDialog } from './SettingsDialog';
import { ShortcutsDialog } from './ShortcutsDialog';

function stringProp(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === 'string' ? value : undefined;
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
      return <SettingsDialog onClose={close} />;
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
    default:
      return null;
  }
}
