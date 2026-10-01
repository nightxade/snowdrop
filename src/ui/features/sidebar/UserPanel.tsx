import { Bell, BellOff, Settings } from 'lucide-react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import { initialsFor, type ConnectionStatus } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useShrike, useKeybindLabel } from '@/ui/hooks';
import { Avatar, IconButton } from '@/ui/primitives';
import styles from './UserPanel.module.css';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  online: '',
  connecting: 'Connecting…',
  offline: 'Offline',
  error: 'Connection problem',
};

export function UserPanel() {
  const { stores, commands } = useShrike();
  const self = useStore(stores.session, sessionSelectors.self);
  const status = useStore(stores.session, sessionSelectors.status);
  const backend = useStore(stores.session, (s) => s.backendKind);
  const notify = useStore(stores.settings, (s) => s.notifications.enabled);
  const settingsKey = useKeybindLabel(CoreCommand.OpenSettings);

  const name = self?.name ?? 'You';
  const subtitle =
    status === 'online'
      ? backend === 'mock'
        ? 'Demo account'
        : 'Linked device'
      : STATUS_TEXT[status];

  return (
    <section className={styles.panel} aria-label="Your account" data-shrike="user-panel">
      <div className={styles.identity}>
        <Avatar
          fallback={initialsFor(name)}
          color={self?.color ?? 'var(--shrike-avatar-1)'}
          src={self?.avatarUrl}
          size={32}
        />
        <div className={styles.text}>
          <span className={styles.name}>{name}</span>
          <span className={styles.subtitle} data-status={status}>
            {subtitle}
          </span>
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
      </div>
    </section>
  );
}
