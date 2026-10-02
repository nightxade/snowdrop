import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { LinkFlow } from '@/core/backend';
import { ShrikeMark, TooltipProvider } from '@/ui/primitives';
import { AccountPrompt } from './AccountPrompt';
import styles from './Welcome.module.css';
import setup from './Setup.module.css';

// The QR encoder only matters for people linking a device.
const LinkDevice = lazy(() => import('./LinkDevice').then((m) => ({ default: m.LinkDevice })));

export interface ConnectionSetupProps {
  /** Why setup is needed: no linked account, or a single-account daemon that needs its number. */
  reason: 'no-account' | 'account-required';
  link: LinkFlow | undefined;
  onLinked: (accountId: string) => void;
  onAccount: (account: string) => void;
  /** Leave signal-cli (back to the welcome screen). */
  onBack: () => void;
}

export function ConnectionSetup({
  reason,
  link,
  onLinked,
  onAccount,
  onBack,
}: ConnectionSetupProps) {
  return (
    <TooltipProvider>
      <main className={styles.screen} data-shrike="welcome">
        <div className={styles.streaks} aria-hidden />
        <div className={[styles.column, setup.wide].join(' ')}>
          <div className={styles.brand}>
            <ShrikeMark size={40} className={styles.mark} />
            <h1 className={setup.wordmark}>Shrike</h1>
          </div>
          {reason === 'no-account' ? (
            <Suspense fallback={<div className={setup.card} aria-busy="true" />}>
              <LinkDevice link={link} onLinked={onLinked} />
            </Suspense>
          ) : (
            <AccountPrompt onSubmit={onAccount} />
          )}
          <button type="button" className={styles.back} onClick={onBack}>
            <ArrowLeft size={16} aria-hidden />
            Use the demo or another daemon
          </button>
        </div>
      </main>
    </TooltipProvider>
  );
}
