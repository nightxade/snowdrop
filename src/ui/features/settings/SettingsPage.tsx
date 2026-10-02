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
import { PluginsPage } from './plugins/PluginsPage';
import { QuickCssPage } from './themes/QuickCssPage';
import { ThemesPage } from './themes/ThemesPage';

/** Renders one settings page by id. */
export function SettingsPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (page: string) => void;
}) {
  switch (id) {
    case 'profile':
      return <ProfilePage />;
    case 'privacy':
      return <PrivacyPage />;
    case 'appearance':
      return <AppearancePage />;
    case 'accessibility':
      return <AccessibilityPage />;
    case 'notifications':
      return <NotificationsPage onNavigate={onNavigate} />;
    case 'keybinds':
      return <KeybindsPage />;
    case 'behaviour':
      return <BehaviourPage />;
    case 'plugins':
      return <PluginsPage />;
    case 'themes':
      return <ThemesPage />;
    case 'quickcss':
      return <QuickCssPage />;
    case 'connection':
      return <ConnectionPage />;
    case 'data':
      return <DataPage />;
    case 'about':
      return <AboutPage />;
    default:
      return null;
  }
}
