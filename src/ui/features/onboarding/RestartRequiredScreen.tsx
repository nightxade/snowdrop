/**
 * `StorageStatus.restartRequired`: "Erase all local data" (or "Start
 * fresh…") has run in this process, but the actual restart hasn't happened
 * yet (docs/ENCRYPTION.md, "Erase" §4 — the vault bridge and the
 * single-instance lock are one-shot per process, so `state` stays
 * `'needsSetup'` and every other storage command refuses until a fresh
 * process starts). Shown instead of the setup wizard whenever this flag is
 * set, no matter which screen would otherwise show, so the user is never
 * dropped back into "Protect your data" on data that's already gone.
 */
import { describeFailure } from '@/ui/lib/connectionErrors';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/primitives';
import { OnboardingShell } from './OnboardingShell';
import setupStyles from './Setup.module.css';

export interface RestartRequiredScreenProps {
  onRestart: () => Promise<void>;
}

export function RestartRequiredScreen({ onRestart }: RestartRequiredScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <OnboardingShell>
      <section
        className={setupStyles.card}
        aria-labelledby="restart-title"
        data-snowdrop="restart-required"
      >
        <h2 id="restart-title" className={setupStyles.title}>
          Restart Snowdrop to finish
        </h2>
        <p className={setupStyles.lede}>
          Your local data was erased. Snowdrop needs to restart once before it can be set up again.
        </p>
        {error && (
          <p className={setupStyles.error} role="alert">
            Snowdrop couldn&rsquo;t restart itself ({error}). Close it and open it again yourself.
          </p>
        )}
        <div className={setupStyles.actions}>
          <Button
            type="button"
            variant="primary"
            icon={
              busy ? <RotateCw size={16} className={setupStyles.spin} /> : <RotateCw size={16} />
            }
            autoFocus
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              // Success replaces this process, so busy only clears on failure.
              void onRestart().catch((e: unknown) => {
                setError(describeFailure(e));
                setBusy(false);
              });
            }}
          >
            Restart Snowdrop
          </Button>
        </div>
      </section>
    </OnboardingShell>
  );
}
