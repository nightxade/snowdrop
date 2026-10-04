/**
 * Boots the desktop app behind encrypted storage (docs/ENCRYPTION.md, "UX").
 * The one state machine for "what do we show before the vault is open":
 * `StorageStatus.state` picks the screen, and every screen only ever reports
 * a fresh `StorageStatus` back up — this is the only place that decides what
 * that means. Nothing else should branch on storage state.
 */
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StorageAdmin, StorageStatus } from '@/core/backend';
import { fromBase64, webCryptoCipher } from '@/core/persistence';
import type { ThemeDocument } from '@/core/themes';
// Imported by file, not the onboarding barrel: the barrel also re-exports
// Welcome/ConnectionSetup/LinkDevice, which App.tsx loads lazily — a static
// import of the barrel here would pull all of it into the main bundle.
import { OnboardingShell } from '@/ui/features/onboarding/OnboardingShell';
import { StorageSetup } from '@/ui/features/onboarding/StorageSetup';
import storageStyles from '@/ui/features/onboarding/Storage.module.css';
import { StorageUnavailable } from '@/ui/features/onboarding/StorageUnavailable';
import { UnlockScreen } from '@/ui/features/onboarding/UnlockScreen';
import { applyBootAppearance } from './bootAppearance';
import { createPersistence, type Persistence } from './persistence';

export interface StorageGateProps {
  admin: StorageAdmin;
  document?: ThemeDocument;
  /** Rendered once storage is unlocked and the encrypted persistence layer is ready. */
  children: (persistence: Persistence) => ReactNode;
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'blocked'; status: StorageStatus }
  | { kind: 'booting' }
  | { kind: 'ready'; persistence: Persistence }
  | { kind: 'failed'; message: string };

export function StorageGate({ admin, document, children }: StorageGateProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const booting = useRef(false);

  const boot = () => {
    if (booting.current) return;
    booting.current = true;
    setPhase({ kind: 'booting' });
    void admin
      .webcacheKey()
      .then((keyBase64) => webCryptoCipher(fromBase64(keyBase64)))
      .then((cipher) => createPersistence({ cipher }))
      .then((persistence) => {
        setPhase({ kind: 'ready', persistence });
      })
      .catch((error: unknown) => {
        booting.current = false;
        console.error('[snowdrop] failed to open encrypted storage', error);
        setPhase({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const route = (status: StorageStatus) => {
    if (status.state === 'unlocked') boot();
    else setPhase({ kind: 'blocked', status });
  };

  useEffect(() => {
    if (document) applyBootAppearance(document);
    void admin.status().then(route);
    // Intentionally runs once: every later transition comes from a screen
    // calling `route` with a fresh status, not from re-polling here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase.kind === 'ready') return <>{children(phase.persistence)}</>;

  if (phase.kind === 'checking' || phase.kind === 'booting') {
    return (
      <OnboardingShell>
        <div className={storageStyles.checking} aria-busy="true" aria-live="polite">
          <LoaderCircle className={storageStyles.spin} size={28} aria-hidden />
        </div>
      </OnboardingShell>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <OnboardingShell>
        <p className={storageStyles.checking} role="alert">
          Snowdrop couldn&rsquo;t open its encrypted storage: {phase.message}
        </p>
      </OnboardingShell>
    );
  }

  const { status } = phase;
  if (status.state === 'needsSetup') {
    return <StorageSetup status={status} admin={admin} onDone={route} />;
  }
  if (status.state === 'locked') {
    return <UnlockScreen status={status} admin={admin} onStatusChange={route} />;
  }
  return <StorageUnavailable reason={status.reason} onRetry={() => admin.status().then(route)} />;
}
