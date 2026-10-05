/** Core commands registered by the composition root (no view state needed). */
import { type CommandRegistry, CoreCommand, DEFAULT_KEYBINDS, NavCommand } from '@/core/commands';
import type { SyncService } from '@/core/services';
import { HOME, spacesSelectors, uiSelectors, type Stores } from '@/core/stores';
import { BUILTIN_THEMES } from '@/core/themes';
import { followConversationOpenFocus } from '@/ui/hooks';

/**
 * The core commands that need no view state: switcher, palette, settings
 * pages, shortcut sheet, member list, spaces, density, notifications, theme
 * commands and mark-as-read. Commands that need view order or focus
 * (conversation and message navigation, search, jump to present, message
 * actions) are registered by the UI against the same ids (`useCoreCommands`,
 * `useChatCommands`).
 */
export function registerCoreCommands(
  commands: CommandRegistry,
  stores: Stores,
  sync: SyncService,
): void {
  const ui = () => stores.ui.getState();
  commands.register({
    id: CoreCommand.QuickSwitcher,
    title: 'Open quick switcher',
    category: 'Navigation',
    keybind: DEFAULT_KEYBINDS[CoreCommand.QuickSwitcher],
    allowInInputs: true,
    run: () => {
      ui().openModal({ type: 'switcher' });
    },
  });
  commands.register({
    id: CoreCommand.ToggleMemberList,
    title: 'Toggle member list',
    category: 'View',
    keybind: DEFAULT_KEYBINDS[CoreCommand.ToggleMemberList],
    allowInInputs: true,
    run: () => {
      ui().toggleMemberList();
    },
  });
  commands.register({
    id: CoreCommand.OpenSettings,
    title: 'Open settings',
    category: 'App',
    keybind: DEFAULT_KEYBINDS[CoreCommand.OpenSettings],
    allowInInputs: true,
    run: () => {
      ui().openModal({ type: 'settings' });
    },
  });
  commands.register({
    id: CoreCommand.ShortcutHelp,
    title: 'Keyboard shortcuts',
    category: 'App',
    keybind: DEFAULT_KEYBINDS[CoreCommand.ShortcutHelp],
    allowInInputs: true,
    run: () => {
      ui().openModal({ type: 'shortcuts' });
    },
  });
  // Palette-only actions (no default keys; bindable in Settings → Keybinds).
  const settings = () => stores.settings.getState();
  commands.register({
    id: NavCommand.CommandPalette,
    title: 'Open command palette',
    category: 'Navigation',
    allowInInputs: true,
    run: () => {
      ui().openModal({ type: 'switcher', props: { query: '>' } });
    },
  });
  /** Home, then every space in rail order, wrapping. */
  const stepSpace = (delta: 1 | -1) => {
    const order = [HOME, ...spacesSelectors.orderedIds(stores.spaces.getState())];
    const i = order.indexOf(ui().selectedSpace);
    const next = order[(Math.max(0, i) + delta + order.length) % order.length];
    if (next === undefined) return;
    ui().selectSpace(next);
    // A no-op unless a plugin's focus policy is active (Vim mode's gt/gT).
    const id = uiSelectors.selectedConversation(ui());
    if (id) followConversationOpenFocus(id);
  };
  commands.register({
    id: NavCommand.NextSpace,
    title: 'Next space',
    category: 'Spaces',
    run: () => {
      stepSpace(1);
    },
  });
  commands.register({
    id: NavCommand.PrevSpace,
    title: 'Previous space',
    category: 'Spaces',
    run: () => {
      stepSpace(-1);
    },
  });
  commands.register({
    id: 'core.createSpace',
    title: 'Create a space',
    category: 'Spaces',
    run: () => {
      ui().openModal({ type: 'createSpace' });
    },
  });
  commands.register({
    id: 'core.toggleDensity',
    title: 'Toggle compact mode',
    category: 'View',
    run: () => {
      const density = settings().appearance.density === 'compact' ? 'comfortable' : 'compact';
      settings().update('appearance', { density });
    },
  });
  commands.register({
    id: 'core.toggleNotifications',
    title: 'Toggle desktop notifications',
    category: 'App',
    run: () => {
      settings().update('notifications', { enabled: !settings().notifications.enabled });
    },
  });
  for (const [page, title] of [
    ['plugins', 'Open plugins'],
    ['themes', 'Open themes'],
    ['appearance', 'Open appearance settings'],
    ['keybinds', 'Edit keyboard shortcuts'],
  ] as const) {
    commands.register({
      id: `core.settings.${page}`,
      title,
      category: 'App',
      run: () => {
        ui().openModal({ type: 'settings', props: { page } });
      },
    });
  }
  // ">dark" in the switcher: one command per built-in theme.
  for (const theme of BUILTIN_THEMES) {
    commands.register({
      id: `core.theme.${theme.id}`,
      title: `Theme: ${theme.name}, ${theme.kind}`,
      category: 'Theme',
      enabled: () => settings().appearance.themeId !== theme.id,
      run: () => {
        settings().update('appearance', { themeId: theme.id });
      },
    });
  }
  commands.register({
    id: CoreCommand.MarkRead,
    title: 'Mark conversation as read',
    category: 'Conversation',
    keybind: DEFAULT_KEYBINDS[CoreCommand.MarkRead],
    enabled: () => uiSelectors.selectedConversation(ui()) !== null,
    run: async () => {
      const id = uiSelectors.selectedConversation(ui());
      if (id) await sync.markConversationRead(id);
    },
  });
}
