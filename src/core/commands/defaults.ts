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
