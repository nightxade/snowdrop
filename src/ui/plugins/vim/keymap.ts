/**
 * Vim mode's app keymap (navigation layer) and the help shown in the
 * Ctrl+/ sheet and the plugin's settings panel. Bindings are data: each runs
 * through `VimActions`, which drives the app via command ids.
 */
import {
  CoreCommand,
  formatKeyToken,
  MessageCommand,
  NavCommand,
  parseKeySequence,
  type KeyHelpGroup,
} from '@/core/commands';

export interface VimActions {
  /** Runs a command `count` times (count null = once). */
  run(commandId: string, count?: number | null): void;
  /** Focuses the composer in Insert mode, with the caret where i/a/I/A put it. */
  insert(where: 'cursor' | 'after' | 'start' | 'end'): void;
  /** Runs a command that focuses the composer (reply), arriving in Insert mode. */
  runIntoInsert(commandId: string): void;
  toggleNotifications(): void;
}

export interface NavBinding {
  keys: string;
  run(actions: VimActions, count: number | null): void;
  /** Also available from the composer's Normal mode (app-level keys that don't edit text). */
  inComposer?: boolean;
}

const cmd =
  (id: string, countable = true) =>
  (a: VimActions, count: number | null) => {
    a.run(id, countable ? count : null);
  };

export const NAV_BINDINGS: readonly NavBinding[] = [
  { keys: 'j', run: cmd(MessageCommand.Next) },
  { keys: 'k', run: cmd(MessageCommand.Prev) },
  { keys: 'gg', run: cmd(MessageCommand.First, false) },
  { keys: 'G', run: cmd(MessageCommand.Last, false) },
  { keys: '<C-d>', run: cmd(MessageCommand.HalfPageDown), inComposer: true },
  { keys: '<C-u>', run: cmd(MessageCommand.HalfPageUp), inComposer: true },
  { keys: '<C-e>', run: cmd(MessageCommand.LineDown), inComposer: true },
  { keys: '<C-y>', run: cmd(MessageCommand.LineUp), inComposer: true },
  { keys: 'zz', run: cmd(MessageCommand.Center, false) },
  { keys: 'J', run: cmd(CoreCommand.NextConversation) },
  { keys: 'K', run: cmd(CoreCommand.PrevConversation) },
  { keys: ']u', run: cmd(CoreCommand.NextUnread), inComposer: true },
  { keys: '[u', run: cmd(CoreCommand.PrevUnread), inComposer: true },
  { keys: 'gt', run: cmd(NavCommand.NextSpace), inComposer: true },
  { keys: 'gT', run: cmd(NavCommand.PrevSpace), inComposer: true },
  { keys: '/', run: cmd(NavCommand.OpenSearch, false), inComposer: true },
  { keys: ':', run: cmd(NavCommand.CommandPalette, false), inComposer: true },
  { keys: '?', run: cmd(CoreCommand.ShortcutHelp, false), inComposer: true },
  { keys: 'm', run: cmd(CoreCommand.ToggleMemberList, false) },
  {
    keys: 'i',
    run: (a) => {
      a.insert('cursor');
    },
  },
  {
    keys: 'a',
    run: (a) => {
      a.insert('after');
    },
  },
  {
    keys: 'I',
    run: (a) => {
      a.insert('start');
    },
  },
  {
    keys: 'A',
    run: (a) => {
      a.insert('end');
    },
  },
  { keys: 'o', run: cmd(MessageCommand.Open, false) },
  {
    keys: 'r',
    run: (a) => {
      a.runIntoInsert(MessageCommand.Reply);
    },
  },
  { keys: 'e', run: cmd(MessageCommand.Edit, false) },
  { keys: '+', run: cmd(MessageCommand.React, false) },
  { keys: 'yy', run: cmd(MessageCommand.CopyText, false) },
  { keys: 'Y', run: cmd(MessageCommand.CopyMarkdown, false) },
  { keys: 'dd', run: cmd(MessageCommand.Delete, false) },
  { keys: 'p', run: cmd(MessageCommand.Pin, false) },
  { keys: '<leader>s', run: cmd(CoreCommand.OpenSettings, false), inComposer: true },
  { keys: '<leader>k', run: cmd(CoreCommand.QuickSwitcher, false), inComposer: true },
  {
    keys: '<leader>n',
    run: (a) => {
      a.toggleNotifications();
    },
    inComposer: true,
  },
  { keys: '<leader>p', run: cmd('core.settings.plugins', false), inComposer: true },
];

/** Display form of a binding for keycaps: sequences split by spaces ("g g", "Space s", "Ctrl+D"). */
export function displayKeys(keys: string, leader: string): string {
  return parseKeySequence(keys, leader)
    .map((t) => formatKeyToken(t))
    .join(' ');
}

export const LEADER_OPTIONS = [
  { value: ' ', label: 'Space' },
  { value: ',', label: 'Comma (,)' },
  { value: '\\', label: 'Backslash (\\)' },
  { value: ';', label: 'Semicolon (;)' },
] as const;

type Row = [keys: string, title: string];

const rows = (leader: string, list: readonly Row[]) =>
  list.map(([keys, title]) => ({
    keys: keys
      .split('|')
      .map((k) => displayKeys(k, leader))
      .join('|'),
    title,
  }));

/** Help for the Ctrl+/ sheet and the settings panel; follows the leader setting. */
export function vimHelp(leader: string): KeyHelpGroup[] {
  return [
    {
      title: 'Vim · Navigation',
      items: rows(leader, [
        ['j|k', 'Next / previous message (counts: 5j)'],
        ['gg|G', 'First loaded message / latest message'],
        ['<C-d>|<C-u>', 'Half a page down / up'],
        ['<C-e>|<C-y>', 'Scroll one line down / up'],
        ['zz', 'Centre the focused message'],
        ['J|K', 'Next / previous conversation (counts: 3J)'],
        [']u|[u', 'Next / previous unread conversation'],
        ['gt|gT', 'Next / previous space'],
        ['i|a|I|A', 'Focus the composer in Insert mode'],
        ['<Esc>', 'Clear a pending key sequence'],
      ]),
    },
    {
      title: 'Vim · Focused message',
      items: rows(leader, [
        ['r', 'Reply'],
        ['e', 'Edit (your own)'],
        ['+', 'React'],
        ['o', 'Open attachment, or the quoted message'],
        ['yy', 'Copy text'],
        ['Y', 'Copy as Markdown'],
        ['dd', 'Delete (asks first)'],
        ['p', 'Pin / unpin'],
      ]),
    },
    {
      title: 'Vim · App',
      items: rows(leader, [
        ['/', 'Search in conversation'],
        [':', 'Command palette'],
        ['?', 'Keyboard shortcuts'],
        ['m', 'Toggle member list'],
        ['<leader>s', 'Settings'],
        ['<leader>k', 'Quick switcher'],
        ['<leader>n', 'Toggle desktop notifications'],
        ['<leader>p', 'Plugins'],
      ]),
    },
    {
      title: 'Vim · Composer (Normal mode)',
      items: rows(leader, [
        ['<Esc>|<C-[>', 'Leave Insert / Visual mode; again on an empty draft: back to messages'],
        ['<CR>', 'Send'],
        ['i|a|I|A|o|O', 'Insert before / after / line start / line end / new line'],
        ['h|j|k|l', 'Left / down / up / right'],
        ['w|b|e|W|B|E', 'Word motions'],
        ['0|^|$', 'Line start / first character / line end'],
        ['gg|G', 'First / last line'],
        ['f|t|F|T', 'Find a character (; and , repeat)'],
        ['%', 'Matching bracket'],
        ['d|c|y', 'Delete / change / yank + motion or text object (iw, a", i(…)'],
        ['dd|cc|yy', 'Whole line'],
        ['D|C|Y', 'To line end / to line end / line'],
        ['x|X|s|S|r', 'Delete, substitute, replace a character'],
        ['~|J', 'Toggle case / join lines'],
        ['p|P', 'Put after / before'],
        ['u|<C-r>|.', 'Undo / redo / repeat last change'],
        ['"+y', 'Yank to the system clipboard'],
        ['v|V', 'Visual / Visual Line mode'],
      ]),
    },
    {
      title: 'Vim · Visual mode',
      items: rows(leader, [
        ['d|c|y', 'Delete / change / yank the selection'],
        ['>|<', 'Indent / outdent'],
        ['~|u|U', 'Toggle case / lower / upper'],
        ['o', 'Other end of the selection'],
        ['iw|i"|i(', 'Select a text object'],
      ]),
    },
  ];
}
