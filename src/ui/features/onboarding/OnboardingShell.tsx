import type { ReactNode } from 'react';
import { SnowdropMark, TooltipProvider } from '@/ui/primitives';
import setupStyles from './Setup.module.css';
import welcomeStyles from './Welcome.module.css';

/**
 * The same full-screen shell `Welcome`/`ConnectionSetup` use (brand, glow,
 * centred column), shared by the storage setup/unlock/unavailable screens
 * so they read as part of the same first-run flow rather than a bare card.
 */
export function OnboardingShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <main className={welcomeStyles.screen} data-snowdrop="welcome">
        <div className={welcomeStyles.glow} aria-hidden />
        <div className={[welcomeStyles.column, setupStyles.wide].join(' ')}>
          <div className={welcomeStyles.brand}>
            <SnowdropMark size={40} className={welcomeStyles.mark} />
            <h1 className={setupStyles.wordmark}>Snowdrop</h1>
          </div>
          {children}
        </div>
      </main>
    </TooltipProvider>
  );
}
