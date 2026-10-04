import { AppWindow, HardDrive } from 'lucide-react';
import { useState } from 'react';
import type { StorageReason } from '@/core/backend';
import { Button } from '@/ui/primitives';
import { OnboardingShell } from './OnboardingShell';
import setupStyles from './Setup.module.css';

export interface StorageUnavailableProps {
  /** `'alreadyRunning'` or `'noRamDir'` (docs/ENCRYPTION.md, "signal-cli vault" and "Keyring availability"). */
  reason: StorageReason | null;
  onRetry: () => Promise<void>;
}

/**
 * `state: 'unavailable'`: nothing to unlock, nothing to set up — just an
 * explanation. The only action is retrying, since both causes are usually
 * resolved outside Snowdrop (closing the other instance, a RAM-backed temp
 * dir becoming available).
 */
export function StorageUnavailable({ reason, onRetry }: StorageUnavailableProps) {
  const [checking, setChecking] = useState(false);
  const copy =
    reason === 'alreadyRunning'
      ? {
          icon: <AppWindow size={20} aria-hidden />,
          title: 'Snowdrop is already open',
          body: 'Only one copy of Snowdrop can run at a time, so its data stays consistent. Close the other window, then try again.',
        }
      : {
          icon: <HardDrive size={20} aria-hidden />,
          title: 'No RAM-backed storage is available',
          body: "Snowdrop keeps signal-cli's working files in memory (never on disk, unencrypted) while it runs. This computer doesn't offer a RAM-backed temporary directory, so Snowdrop can't start safely.",
        };
  return (
    <OnboardingShell>
      <section
        className={setupStyles.card}
        aria-labelledby="unavailable-title"
        data-snowdrop="storage-unavailable"
      >
        <h2 id="unavailable-title" className={setupStyles.title}>
          {copy.icon} {copy.title}
        </h2>
        <p className={setupStyles.lede}>{copy.body}</p>
        <div className={setupStyles.actions}>
          <Button
            type="button"
            variant="primary"
            autoFocus
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void onRetry().finally(() => {
                setChecking(false);
              });
            }}
          >
            Try again
          </Button>
        </div>
      </section>
    </OnboardingShell>
  );
}
