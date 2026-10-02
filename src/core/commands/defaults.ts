/**
 * Ids and default keybinds of the core commands (PLAN §4.11). The app
 * registers the implementations; keeping ids here lets settings, docs and
 * plugins refer to them without importing UI code.
 */
export const CoreCommand = {
  QuickSwitcher: 'core.quickSwitcher',
  PrevConversation: 'core.prevConversation',
  NextConversation: 'core.nextConversation',
  PrevUnread: 'core.prevUnread',
  NextUnread: 'core.nextUnread',
  MarkRead: 'core.markConversationRead',
  ToggleMemberList: 'core.toggleMemberList',
  OpenSettings: 'core.openSettings',
  SearchConversation: 'core.searchConversation',
  JumpToPresent: 'core.jumpToPresent',
  ShortcutHelp: 'core.shortcutHelp',
} as const;

export type CoreCommandId = (typeof CoreCommand)[keyof typeof CoreCommand];

export const DEFAULT_KEYBINDS: Readonly<Record<CoreCommandId, string>> = {
  [CoreCommand.QuickSwitcher]: 'Mod+K',
  [CoreCommand.PrevConversation]: 'Alt+Up',
  [CoreCommand.NextConversation]: 'Alt+Down',
  [CoreCommand.PrevUnread]: 'Alt+Shift+Up',
  [CoreCommand.NextUnread]: 'Alt+Shift+Down',
  // Escape only marks read when the composer is empty; the composer handles that case.
  [CoreCommand.MarkRead]: 'Escape',
  [CoreCommand.ToggleMemberList]: 'Mod+Shift+M',
  [CoreCommand.OpenSettings]: 'Mod+,',
  [CoreCommand.SearchConversation]: 'Mod+F',
  [CoreCommand.JumpToPresent]: 'Shift+PageDown',
  [CoreCommand.ShortcutHelp]: 'Mod+/',
};

/**
 * Navigation commands with no default keys: in the palette and bindable in
 * Settings → Keybinds, and driven by keyboard layers such as Vim mode.
 */
export const NavCommand = {
  FocusComposer: 'core.focusComposer',
  FocusMessages: 'core.focusMessages',
  NextSpace: 'core.nextSpace',
  PrevSpace: 'core.prevSpace',
  CommandPalette: 'core.commandPalette',
  /** Opens (never closes) the in-conversation search panel; hidden. */
  OpenSearch: 'core.openSearch',
} as const;

/**
 * Actions on the message list and its focused message (the roving tab stop).
 * Hidden from the palette (they need a focused message) and unbound; Vim
 * mode and other key layers run them through the command registry.
 */
export const MessageCommand = {
  Next: 'chat.message.next',
  Prev: 'chat.message.prev',
  First: 'chat.message.first',
  Last: 'chat.message.last',
  HalfPageDown: 'chat.list.halfPageDown',
  HalfPageUp: 'chat.list.halfPageUp',
  LineDown: 'chat.list.lineDown',
  LineUp: 'chat.list.lineUp',
  Center: 'chat.message.center',
  Reply: 'chat.message.reply',
  Edit: 'chat.message.edit',
  React: 'chat.message.react',
  CopyText: 'chat.message.copyText',
  CopyMarkdown: 'chat.message.copyMarkdown',
  Delete: 'chat.message.delete',
  Pin: 'chat.message.pin',
  Open: 'chat.message.open',
} as const;

export type MessageCommandId = (typeof MessageCommand)[keyof typeof MessageCommand];
