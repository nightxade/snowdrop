import { Copy, Smartphone } from 'lucide-react';
import { useStore } from 'zustand';
import { initialsFor } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { copyText, formatPhone } from '@/ui/features/conversation';
import { useShrike } from '@/ui/hooks';
import { Avatar, Button } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import styles from './pages.module.css';

export function ProfilePage() {
  const app = useShrike();
  const self = useStore(app.stores.session, sessionSelectors.self);
  const backend = app.backend.kind;
  if (!self) {
    return <p className={styles.muted}>Your profile appears here once Shrike has connected.</p>;
  }
  return (
    <SettingsSection>
      <SettingRow id="profile.card" label="Profile" stacked>
        <div className={styles.profile}>
          <Avatar
            size={80}
            {...(self.avatarUrl ? { src: self.avatarUrl } : {})}
            fallback={initialsFor(self.name)}
            color={self.color}
          />
          <div className={styles.profileText}>
            <p className={styles.profileName}>{self.profileName ?? self.name}</p>
            {self.number && <p className={styles.muted}>{formatPhone(self.number)}</p>}
            {self.about && (
              <p className={styles.profileAbout}>
                {self.aboutEmoji ? `${self.aboutEmoji} ` : ''}
                {self.about}
              </p>
            )}
          </div>
        </div>
        <p className={styles.hint}>
          <Smartphone size={14} aria-hidden />
          {backend === 'mock'
            ? 'This is the demo profile. With signal-cli, your real Signal profile shows here.'
            : 'Change your name, photo and about text in the Signal app on your phone; Shrike picks it up automatically.'}
        </p>
      </SettingRow>
      <SettingRow
        id="profile.account"
        label="Account ID"
        description={<code className={styles.code}>{self.id}</code>}
        control={
          <Button
            size="sm"
            icon={<Copy size={14} />}
            onClick={() => {
              void copyText(app, self.id, 'account ID');
            }}
          >
            Copy
          </Button>
        }
      />
    </SettingsSection>
  );
}
