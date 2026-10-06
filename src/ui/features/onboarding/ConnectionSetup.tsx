import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { DesktopAdmin, LinkFlow } from '@/core/backend';
import { SnowdropMark, TooltipProvider } from '@/ui/primitives';
import { AccountPrompt } from './AccountPrompt';
import { DownloadSignalCli } from './DownloadSignalCli';
import { MissingSignalCli } from './MissingSignalCli';
import styles from './Welcome.module.css';
import setup from './Setup.module.css';

// The QR encoder only matters for people linking a device.
const LinkDevice = lazy(() => import('./LinkDevice').then((m) => ({ default: m.LinkDevice })));

export interface ConnectionSetupProps {
  /**
   * Why setup is needed: no linked account, a single-account daemon that
   * needs its number, or (desktop app) no signal-cli program to run.
   */
  reason: 'no-account' | 'account-required' | 'not-installed';
  /** The connection error, shown when signal-cli is missing. */
  errorMessage?: string | null;
  /** Desktop app: use the signal-cli at this path. */
  onProgramPath?: (path: string) => void;
  /**
   * Desktop app, `not-installed`: lets the first-run screen download
   * signal-cli instead of asking for a path. `configured` tells the two
   * `not-installed` cases apart: a custom path the user set that turned out
   * bad (`MissingSignalCli`, asks for another path) versus nothing
   * configured at all, meaning this is the first run and nothing was found
   * (the download screen). Omit it to always fall back to `MissingSignalCli`.
   */
  install?: { admin: DesktopAdmin; configured: boolean; onInstalled: () => void } | undefined;
  link: LinkFlow | undefined;
  onLinked: (accountId: string) => void;
  onAccount: (account: string) => void;
  /** Leave signal-cli (back to the welcome screen). */
  onBack: () => void;
  /** The desktop app: affects LinkDevice's default device name and copy. */
  desktop?: boolean;
}

export function ConnectionSetup({
  reason,
  errorMessage = null,
  onProgramPath,
  install,
  link,
  onLinked,
  onAccount,
  onBack,
  desktop = false,
}: ConnectionSetupProps) {
  return (
    <TooltipProvider>
      <main className={styles.screen} data-snowdrop="welcome">
        <div className={styles.glow} aria-hidden />
        <div className={[styles.column, setup.wide].join(' ')}>
          <div className={styles.brand}>
            <SnowdropMark size={40} className={styles.mark} />
            <h1 className={setup.wordmark}>Snowdrop</h1>
          </div>
          {reason === 'no-account' ? (
            <Suspense fallback={<div className={setup.card} aria-busy="true" />}>
              <LinkDevice link={link} onLinked={onLinked} desktop={desktop} />
            </Suspense>
          ) : reason === 'not-installed' ? (
            install && !install.configured ? (
              <DownloadSignalCli admin={install.admin} onInstalled={install.onInstalled} />
            ) : (
              <MissingSignalCli message={errorMessage} onSubmit={(path) => onProgramPath?.(path)} />
            )
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
