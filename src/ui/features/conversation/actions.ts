/**
 * Conversation actions shared by the sidebar context menu, the row hover
 * buttons, the chat header and keyboard commands.
 */
import { HOUR, MINUTE, type ConversationId, type MuteState } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import type { AppServices } from '@/ui/hooks';

export const MUTE_OPTIONS: readonly { id: string; label: string; ms: number | null }[] = [
  { id: '15m', label: 'For 15 minutes', ms: 15 * MINUTE },
  { id: '1h', label: 'For 1 hour', ms: HOUR },
  { id: '8h', label: 'For 8 hours', ms: 8 * HOUR },
  { id: '24h', label: 'For 24 hours', ms: 24 * HOUR },
  { id: 'forever', label: 'Until I turn it back on', ms: null },
];

export function muteState(ms: number | null, now: number): MuteState {
  return ms === null ? true : { until: now + ms };
}

export function openConversation(
  app: AppServices,
  id: ConversationId,
  space: string = app.stores.ui.getState().selectedSpace,
): void {
  app.stores.ui.getState().selectConversation(id, space);
}

export function markRead(app: AppServices, id: ConversationId): void {
  void app.sync.markConversationRead(id);
}

export function archive(app: AppServices, id: ConversationId, archived: boolean): void {
  app.stores.local.getState().setArchived(id, archived);
  if (archived) {
    // Archiving the open conversation shouldn't leave you staring at it.
    const ui = app.stores.ui.getState();
    if (uiSelectors.selectedConversation(ui) === id) {
      const { [ui.selectedSpace]: _closed, ...rest } = ui.selectedConversationBySpace;
      app.stores.ui.setState({ selectedConversationBySpace: rest });
    }
    app.stores.ui.getState().pushToast({
      message: 'Conversation archived. Find it under Archived in Home.',
      kind: 'info',
      source: 'core',
    });
  }
}

export async function copyText(app: AppServices, text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    app.stores.ui
      .getState()
      .pushToast({ message: `Copied ${what}`, kind: 'success', source: 'core' });
  } catch {
    app.stores.ui.getState().pushToast({
      message: `Couldn't copy ${what}: clipboard access was denied`,
      kind: 'error',
      source: 'core',
    });
  }
}
