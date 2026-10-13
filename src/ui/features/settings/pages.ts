/**
 * The settings map: groups, pages and every searchable entry. Pages render
 * their rows with the same ids, so search can show exactly the matching
 * rows. Plugins are added at runtime (see usePluginEntries).
 */
import {
  Accessibility,
  Bell,
  Braces,
  HardDrive,
  Info,
  Keyboard,
  Paintbrush,
  Palette,
  PlugZap,
  Puzzle,
  Shield,
  SlidersHorizontal,
  Smile,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import type { SettingsPageMeta } from './search';

export type SettingsGroupId = 'you' | 'general' | 'customise' | 'system' | 'plugin-panels';

export const SETTINGS_GROUPS: { id: SettingsGroupId; title: string }[] = [
  { id: 'you', title: 'You' },
  { id: 'general', title: 'General' },
  { id: 'customise', title: 'Customise' },
  { id: 'system', title: 'System' },
  { id: 'plugin-panels', title: 'From plugins' },
];

export const PAGE_IDS = [
  'profile',
  'privacy',
  'appearance',
  'accessibility',
  'notifications',
  'keybinds',
  'behaviour',
  'custom-emoji',
  'plugins',
  'themes',
  'custom-css',
  'connection',
  'data',
  'about',
] as const;

export type SettingsPageId = (typeof PAGE_IDS)[number];

/** Props every page view receives. */
export interface PageProps {
  onNavigate: (page: SettingsPageId) => void;
}

/** One settings page: the single source of its id, group, title, icon and searchable rows. */
export interface SettingsPageDef extends SettingsPageMeta {
  id: SettingsPageId;
  group: SettingsGroupId;
  icon: LucideIcon;
}

export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    id: 'profile',
    group: 'you',
    icon: UserRound,
    title: 'My profile',
    description:
      'How you appear to others. Your profile is managed in the Signal app on your phone.',
    keywords: ['account', 'name', 'avatar', 'number'],
    entries: [
      { id: 'profile.card', label: 'Profile', keywords: ['name', 'about', 'avatar'] },
      { id: 'profile.account', label: 'Account ID', keywords: ['aci', 'number', 'copy'] },
    ],
  },
  {
    id: 'privacy',
    group: 'you',
    icon: Shield,
    title: 'Privacy & security',
    description:
      'What others can learn from you, what Snowdrop keeps on this device, and (desktop) its encryption.',
    keywords: ['security', 'tracking', 'encryption'],
    entries: [
      {
        id: 'privacy.encryptionStatus',
        section: 'encryption',
        label: 'Encrypted on this computer',
        keywords: ['encryption', 'keyring', 'vault', 'status'],
      },
      {
        id: 'privacy.recoveryKey',
        section: 'recovery',
        label: 'Recovery key',
        keywords: ['recovery', 'backup code'],
      },
      {
        id: 'privacy.removeRecoveryKey',
        section: 'recovery',
        label: 'Remove recovery key',
        keywords: ['recovery'],
      },
      {
        id: 'privacy.passphrase',
        section: 'passphrase',
        label: 'Passphrase',
        keywords: ['password', 'unlock'],
      },
      {
        id: 'privacy.keyring',
        section: 'keyring',
        label: 'Re-save key to this keyring',
        keywords: ['keyring', 'kwallet', 'gnome keyring', 'keepassxc', 'keychain'],
      },
      {
        id: 'privacy.eraseAll',
        section: 'danger-zone',
        label: 'Erase all local data',
        keywords: ['erase', 'wipe', 'delete', 'reset'],
      },
      {
        id: 'privacy.receipts',
        section: 'signals',
        label: 'Send read receipts',
        description: 'Tell people when you’ve read their messages.',
      },
      {
        id: 'privacy.typing',
        section: 'signals',
        label: 'Send typing indicators',
        description: 'Show people when you’re writing to them.',
        keywords: ['silent', 'typing'],
      },
      {
        id: 'privacy.clearUrls',
        section: 'links',
        label: 'Strip tracking parameters from links',
        description: 'Uses the Clear URLs plugin.',
        keywords: ['utm', 'fbclid'],
      },
      {
        id: 'privacy.local',
        section: 'local',
        label: 'What stays on this device',
        keywords: ['spaces', 'notes', 'history', 'local'],
      },
    ],
  },
  {
    id: 'appearance',
    group: 'general',
    icon: Palette,
    title: 'Appearance',
    description: 'Theme, accent colour, density and text size. Changes apply as you make them.',
    keywords: ['look', 'display'],
    entries: [
      {
        id: 'appearance.theme',
        section: 'theme',
        label: 'Theme',
        keywords: ['dark', 'light', 'dusk', 'midnight', 'linen', 'contrast'],
      },
      {
        id: 'appearance.accent',
        section: 'theme',
        label: 'Accent colour',
        keywords: ['color', 'highlight'],
      },
      {
        id: 'appearance.density',
        section: 'layout',
        label: 'Message density',
        keywords: ['compact', 'comfortable', 'spacing'],
      },
      { id: 'appearance.compactAvatars', section: 'layout', label: 'Show avatars in compact mode' },
      {
        id: 'appearance.splitHome',
        section: 'layout',
        label: 'Separate groups and direct messages',
        keywords: ['home', 'sidebar', 'dms', 'groups', 'split', 'sections'],
      },
      {
        id: 'appearance.clock',
        section: 'layout',
        label: 'Time format',
        keywords: ['12', '24', 'hour', 'clock'],
      },
      {
        id: 'appearance.fontScale',
        section: 'text',
        label: 'Text size',
        keywords: ['font', 'scale'],
      },
      { id: 'appearance.zoom', section: 'text', label: 'Zoom', keywords: ['ui', 'scale'] },
    ],
  },
  {
    id: 'accessibility',
    group: 'general',
    icon: Accessibility,
    title: 'Accessibility',
    description: 'Motion, focus visibility, colour and target size.',
    keywords: ['a11y'],
    entries: [
      { id: 'a11y.motion', label: 'Reduce motion', keywords: ['animation'] },
      { id: 'a11y.focus', label: 'High-contrast focus outline', keywords: ['keyboard', 'ring'] },
      { id: 'a11y.targets', label: 'Larger click targets', keywords: ['touch', 'size'] },
      { id: 'a11y.saturation', label: 'Saturation', keywords: ['colour', 'color', 'grayscale'] },
    ],
  },
  {
    id: 'notifications',
    group: 'general',
    icon: Bell,
    title: 'Notifications',
    description: 'Desktop notifications for new messages.',
    keywords: ['alerts', 'desktop'],
    entries: [
      { id: 'notifications.permission', label: 'Browser permission', keywords: ['allow', 'test'] },
      { id: 'notifications.enabled', section: 'when', label: 'Desktop notifications' },
      {
        id: 'notifications.mode',
        section: 'when',
        label: 'Notify me about',
        keywords: ['mentions', 'all'],
      },
      {
        id: 'notifications.preview',
        section: 'when',
        label: 'Show message text',
        keywords: ['preview', 'privacy'],
      },
      {
        id: 'notifications.mute',
        section: 'when',
        label: 'Muting spaces and conversations',
        keywords: ['mute', 'space', 'override'],
      },
      { id: 'notifications.sound', section: 'when', label: 'Sounds' },
    ],
  },
  {
    id: 'keybinds',
    group: 'general',
    icon: Keyboard,
    title: 'Keybinds',
    description: 'Every command and its shortcut, including ones that have none yet.',
    keywords: ['keyboard', 'shortcuts', 'hotkeys'],
    entries: [{ id: 'keybinds.list', label: 'Shortcuts' }],
  },
  {
    id: 'behaviour',
    group: 'general',
    icon: SlidersHorizontal,
    title: 'Behaviour',
    description: 'How the composer and messages behave.',
    keywords: ['behavior', 'composer', 'chat'],
    entries: [
      { id: 'behaviour.enter', label: 'Send with', keywords: ['enter', 'shift', 'newline'] },
      { id: 'behaviour.markdown', label: 'Markdown formatting', keywords: ['bold', 'italic'] },
    ],
  },
  {
    id: 'custom-emoji',
    group: 'customise',
    icon: Smile,
    title: 'Custom emoji',
    description: 'Your own emoji: images, or text like ¯\\_(ツ)_/¯. Type :name: to use one, in any chat.',
    keywords: ['emoji', 'sticker', 'image', 'picker'],
    entries: [
      { id: 'customEmoji.add', label: 'Add an emoji', keywords: ['name', 'image', 'upload'] },
      { id: 'customEmoji.collection', label: 'Your collection', keywords: ['remove', 'manage'] },
    ],
  },
  {
    id: 'plugins',
    group: 'customise',
    icon: Puzzle,
    title: 'Plugins',
    description: 'Turn features on and off. Everything applies immediately, no restart.',
    keywords: ['extensions', 'addons'],
    entries: [{ id: 'plugins.grid', label: 'Plugins' }],
  },
  {
    id: 'themes',
    group: 'customise',
    icon: Paintbrush,
    title: 'Themes',
    description: 'Built-in themes, plus your own as JSON files.',
    keywords: ['colours', 'import', 'export'],
    entries: [
      { id: 'themes.builtin', label: 'Themes', keywords: ['dusk', 'midnight', 'linen'] },
      { id: 'themes.import', label: 'Import a theme', keywords: ['json', 'file', 'export'] },
    ],
  },
  {
    id: 'custom-css',
    group: 'customise',
    icon: Braces,
    title: 'Custom CSS',
    description: 'Your own CSS, applied live on top of the theme.',
    keywords: ['quickcss', 'style', 'stylesheet', 'safe mode'],
    entries: [
      { id: 'custom-css.editor', label: 'Editor' },
      {
        id: 'custom-css.hooks',
        label: 'Styling hooks',
        keywords: ['data-snowdrop', 'selectors', 'tokens'],
      },
    ],
  },
  {
    id: 'connection',
    group: 'system',
    icon: PlugZap,
    title: 'Connection',
    description: 'Where Snowdrop gets your messages from.',
    keywords: ['signal-cli', 'daemon', 'demo', 'backend', 'server'],
    entries: [
      { id: 'connection.backend', label: 'Source', keywords: ['demo', 'signal-cli'] },
      {
        id: 'connection.desktopMode',
        label: 'Run signal-cli',
        keywords: ['desktop', 'bundled', 'external', 'daemon'],
      },
      {
        id: 'connection.program',
        label: 'signal-cli program',
        keywords: ['path', 'bundled', 'install', 'binary'],
      },
      { id: 'connection.url', label: 'Daemon address', keywords: ['url', 'proxy'] },
      { id: 'connection.account', label: 'Account', keywords: ['number', 'phone'] },
      { id: 'connection.test', label: 'Test connection' },
      { id: 'connection.liveliness', label: 'Simulated activity', keywords: ['demo'] },
      {
        id: 'connection.signOut',
        label: 'Sign out',
        keywords: ['leave demo', 'disconnect', 'log out', 'unlink'],
      },
    ],
  },
  {
    id: 'data',
    group: 'system',
    icon: HardDrive,
    title: 'Data & storage',
    description: 'Your message history is stored only on this device. Export it or clear it here.',
    keywords: ['history', 'backup', 'storage'],
    entries: [
      { id: 'data.usage', label: 'Storage used', keywords: ['quota', 'size'] },
      { id: 'data.export', label: 'Export history', keywords: ['download', 'json', 'backup'] },
      {
        id: 'data.diagnosticsVerbose',
        section: 'diagnostics',
        label: 'Verbose logging',
        keywords: ['debug', 'log', 'diagnostics', 'troubleshoot'],
      },
      {
        id: 'data.diagnosticsCopyLog',
        section: 'diagnostics',
        label: 'Copy recent log',
        keywords: ['log', 'diagnostics', 'copy', 'debug', 'support'],
      },
      {
        id: 'data.diagnosticsOpenFolder',
        section: 'diagnostics',
        label: 'Open log folder',
        keywords: ['log', 'diagnostics', 'folder', 'file manager'],
      },
      { id: 'data.clear', label: 'Clear history', keywords: ['delete', 'wipe'] },
      { id: 'data.reset', label: 'Reset all settings', keywords: ['defaults'] },
    ],
  },
  {
    id: 'about',
    group: 'system',
    icon: Info,
    title: 'About',
    description: 'Version, licences and the fine print.',
    keywords: ['licenses', 'licences', 'version', 'legal', 'credits'],
    entries: [
      { id: 'about.version', label: 'Version' },
      { id: 'about.licences', label: 'Open-source licences', keywords: ['mit', 'dependencies'] },
      {
        id: 'about.signalCli',
        label: 'signal-cli',
        keywords: ['gpl', 'source', 'licence', 'license', 'bundled'],
      },
      { id: 'about.legal', label: 'Legal', keywords: ['trademark', 'signal'] },
    ],
  },
];

export const DEFAULT_PAGE: SettingsPageId = 'appearance';
