import { Bell, BellOff, LogOut, MoreVertical, Settings } from 'lucide-react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import { initialsFor, type ConnectionStatus } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop, useKeybindLabel } from '@/ui/hooks';
import { Avatar, DropdownMenu, IconButton, type MenuEntry } from '@/ui/primitives';
import styles from './UserPanel.module.css';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  online: '',
  connecting: 'Connecting…',
  offline: 'Offline',
  error: 'Connection problem',
};

export function UserPanel() {
  const { stores, commands } = useSnowdrop();
  const self = useStore(stores.session, sessionSelectors.self);
  const status = useStore(stores.session, sessionSelectors.status);
  const backend = useStore(stores.session, (s) => s.backendKind);
  const historyImport = useStore(stores.session, sessionSelectors.historyImport);
  const notify = useStore(stores.settings, (s) => s.notifications.enabled);
  const settingsKey = useKeybindLabel(CoreCommand.OpenSettings);

  const accountMenu = (): MenuEntry[] => [
    {
      kind: 'item',
      id: 'signOut',
      label: 'Sign out…',
      icon: <LogOut size={16} />,
      danger: true,
      onSelect: () => {
        void commands.execute('core.signOut');
      },
    },
  ];

  const name = self?.name ?? 'You';
  const importing = status === 'online' && historyImport.status === 'importing';
  const subtitle = importing
    ? `Importing message history… ${historyImport.percent}%`
    : status === 'online'
      ? backend === 'mock'
        ? 'Demo account'
        : 'Linked device'
      : STATUS_TEXT[status];

  return (
    <section
      className={styles.panel}
      aria-label="Your account"
      data-snowdrop="user-panel"
      data-pane-title="you"
    >
      <div className={styles.identity}>
        <Avatar
          fallback={initialsFor(name)}
          color={self?.color ?? 'var(--snowdrop-avatar-1)'}
          src={self?.avatarUrl}
          size={32}
        />
        <div className={styles.text}>
          <span className={styles.name}>{name}</span>
          <span className={styles.subtitle} data-status={status}>
            {subtitle}
          </span>
          {importing && (
            <div
              className={styles.importProgress}
              role="progressbar"
              aria-label="Importing message history"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={historyImport.percent}
            >
              <span style={{ width: `${historyImport.percent}%` }} />
            </div>
          )}
        </div>
      </div>
      <div className={styles.buttons}>
        <IconButton
          label={notify ? 'Turn off notifications' : 'Turn on notifications'}
          icon={notify ? <Bell /> : <BellOff />}
          active={!notify}
          className={notify ? undefined : styles.off}
          onClick={() => {
            stores.settings.getState().update('notifications', { enabled: !notify });
          }}
        />
        <IconButton
          label="Settings"
          icon={<Settings />}
          {...(settingsKey ? { shortcut: settingsKey } : {})}
          onClick={() => {
            void commands.execute(CoreCommand.OpenSettings);
          }}
        />
        <DropdownMenu entries={accountMenu} align="end" label="Account menu">
          <IconButton label="Account menu" icon={<MoreVertical />} />
        </DropdownMenu>
      </div>
    </section>
  );
}
