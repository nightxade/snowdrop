import type { ComponentType } from 'react';
import { AboutPage } from './about/AboutPage';
import { KeybindsPage } from './keybinds/KeybindsPage';
import { AccessibilityPage } from './pages/AccessibilityPage';
import { AppearancePage } from './pages/AppearancePage';
import { BehaviourPage } from './pages/BehaviourPage';
import { ConnectionPage } from './pages/ConnectionPage';
import { DataPage } from './pages/DataPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ProfilePage } from './pages/ProfilePage';
import type { PageProps, SettingsPageId } from './pages';
import { PluginsPage } from './plugins/PluginsPage';
import { CustomCssPage } from './themes/CustomCssPage';
import { ThemesPage } from './themes/ThemesPage';

/** Every page id in pages.ts must have a view (the Record type enforces it). */
const VIEWS: Record<SettingsPageId, ComponentType<PageProps>> = {
  profile: ProfilePage,
  privacy: PrivacyPage,
  appearance: AppearancePage,
  accessibility: AccessibilityPage,
  notifications: NotificationsPage,
  keybinds: KeybindsPage,
  behaviour: BehaviourPage,
  plugins: PluginsPage,
  themes: ThemesPage,
  'custom-css': CustomCssPage,
  connection: ConnectionPage,
  data: DataPage,
  about: AboutPage,
};

export function SettingsPage({ id, onNavigate }: { id: SettingsPageId } & PageProps) {
  const View = VIEWS[id];
  return <View onNavigate={onNavigate} />;
}
