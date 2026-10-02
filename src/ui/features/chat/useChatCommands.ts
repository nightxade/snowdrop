import { useEffect } from 'react';
import {
  type Command,
  CoreCommand,
  DEFAULT_KEYBINDS,
  MessageCommand,
  NavCommand,
} from '@/core/commands';
import { uiSelectors } from '@/core/stores';
import { useShrike } from '@/ui/hooks';
import { useChatController } from './ChatController';
import type { MessageAction } from './list/rowState';

const MESSAGE_ACTIONS: readonly [id: string, title: string, action: MessageAction][] = [
  [MessageCommand.Reply, 'Reply to focused message', 'reply'],
  [MessageCommand.Edit, 'Edit focused message', 'edit'],
  [MessageCommand.React, 'React to focused message', 'react'],
  [MessageCommand.CopyText, 'Copy focused message text', 'copyText'],
  [MessageCommand.CopyMarkdown, 'Copy focused message as Markdown', 'copyMarkdown'],
  [MessageCommand.Delete, 'Delete focused message', 'delete'],
  [MessageCommand.Pin, 'Pin or unpin focused message', 'pin'],
  [MessageCommand.Open, 'Open focused message’s attachment or quote', 'open'],
];

/**
 * Registers the commands that need the message list (PLAN §4.11): jump to
 * present, search, and the hidden list/message actions that key layers
 * (Vim mode) drive through the registry.
 */
export function useChatCommands(): void {
  const { commands, stores } = useShrike();
  const chat = useChatController();
  useEffect(() => {
    const hasConversation = () => uiSelectors.selectedConversation(stores.ui.getState()) !== null;
    const hasList = () => chat.navigation !== null;
    /** Hidden: they act on the focused message, which the palette can't target. */
    const listCommand = (id: string, title: string, run: () => void): Command => ({
      id,
      title,
      category: 'Messages',
      hidden: true,
      enabled: hasList,
      run,
    });
    const nav = () => chat.navigation;
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
      commands.register({
        id: NavCommand.OpenSearch,
        title: 'Open search in conversation',
        category: 'Conversation',
        hidden: true,
        enabled: hasConversation,
        run: () => {
          chat.setSearchOpen(true);
        },
      }),
      commands.register({
        id: NavCommand.FocusComposer,
        title: 'Focus the message composer',
        category: 'Navigation',
        enabled: hasConversation,
        run: () => {
          chat.focusComposer();
        },
      }),
      commands.register({
        id: NavCommand.FocusMessages,
        title: 'Focus the message list',
        category: 'Navigation',
        enabled: hasList,
        run: () => {
          nav()?.focus();
        },
      }),
      commands.register(
        listCommand(MessageCommand.Next, 'Next message', () => {
          nav()?.navigate('next', 1);
        }),
      ),
      commands.register(
        listCommand(MessageCommand.Prev, 'Previous message', () => {
          nav()?.navigate('prev', 1);
        }),
      ),
      commands.register(
        listCommand(MessageCommand.First, 'First loaded message', () =>
          nav()?.navigate('first', 1),
        ),
      ),
      commands.register(
        listCommand(MessageCommand.Last, 'Latest message', () => {
          nav()?.navigate('last', 1);
        }),
      ),
      commands.register(
        listCommand(MessageCommand.HalfPageDown, 'Scroll half a page down', () => {
          nav()?.scroll('halfPage', 1, 1);
        }),
      ),
      commands.register(
        listCommand(MessageCommand.HalfPageUp, 'Scroll half a page up', () => {
          nav()?.scroll('halfPage', -1, 1);
        }),
      ),
      commands.register(
        listCommand(MessageCommand.LineDown, 'Scroll one line down', () => {
          nav()?.scroll('line', 1, 1);
        }),
      ),
      commands.register(
        listCommand(MessageCommand.LineUp, 'Scroll one line up', () => {
          nav()?.scroll('line', -1, 1);
        }),
      ),
      commands.register(
        listCommand(MessageCommand.Center, 'Centre focused message', () => {
          nav()?.center();
        }),
      ),
      ...MESSAGE_ACTIONS.map(([id, title, action]) =>
        commands.register(
          listCommand(id, title, () => {
            nav()?.act(action);
          }),
        ),
      ),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [commands, stores, chat]);
}
