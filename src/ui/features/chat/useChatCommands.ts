import { useEffect } from 'react';
import { CoreCommand, DEFAULT_KEYBINDS } from '@/core/commands';
import { uiSelectors } from '@/core/stores';
import { useShrike } from '@/ui/hooks';
import { useChatController } from './ChatController';

/** Registers the commands that need the message list (PLAN §4.11): jump to present, search. */
export function useChatCommands(): void {
  const { commands, stores } = useShrike();
  const chat = useChatController();
  useEffect(() => {
    const hasConversation = () => uiSelectors.selectedConversation(stores.ui.getState()) !== null;
    const disposers = [
      commands.register({
        id: CoreCommand.JumpToPresent,
        title: 'Jump to present',
        category: 'Conversation',
        keybind: DEFAULT_KEYBINDS[CoreCommand.JumpToPresent],
        allowInInputs: true,
        enabled: hasConversation,
        run: () => chat.jumpToPresent(),
      }),
      commands.register({
        id: CoreCommand.SearchConversation,
        title: 'Search in conversation',
        category: 'Conversation',
        keybind: DEFAULT_KEYBINDS[CoreCommand.SearchConversation],
        allowInInputs: true,
        enabled: hasConversation,
        run: () => {
          chat.setSearchOpen(!chat.isSearchOpen());
        },
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [commands, stores, chat]);
}
