import { ArrowLeft, PlugZap, Smartphone, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { SnowdropMark, TooltipProvider } from '@/ui/primitives';
import { ConnectForm } from './ConnectForm';
import styles from './Welcome.module.css';

export interface WelcomeProps {
  /** Start the demo world. */
  onDemo: () => void;
  /** Save the daemon URL and connect to signal-cli. */
  onConnect: (daemonUrl: string) => void;
  defaultDaemonUrl: string;
  /** Checks a daemon URL before connecting. */
  probe?: ConnectFormProbe;
  /**
   * The desktop app: it runs the signal-cli bundled with it, so connecting
   * needs no address and goes straight to linking this computer.
   */
  desktop?: boolean;
}

type ConnectFormProbe = Parameters<typeof ConnectForm>[0]['probe'];

/** First run (PLAN §4.10): the one screen where the brand gets room to breathe. */
export function Welcome({ onDemo, onConnect, defaultDaemonUrl, probe, desktop }: WelcomeProps) {
  const [step, setStep] = useState<'choose' | 'connect'>('choose');
  return (
    <TooltipProvider>
      <main className={styles.screen} data-snowdrop="welcome">
        <div className={styles.glow} aria-hidden />
        <div className={styles.column}>
          <div className={styles.brand}>
            <SnowdropMark size={48} className={styles.mark} />
            <h1 className={styles.wordmark}>Snowdrop</h1>
          </div>
          {step === 'choose' ? (
            <>
              <p className={styles.lede}>
                A quiet, private home for your Signal conversations: spaces for your groups, a
                sidebar for everything else, and a shortcut to all of it. Nothing leaves this
                computer.
              </p>
              <div className={styles.choices}>
                <button type="button" className={styles.choice} data-primary onClick={onDemo}>
                  <span className={styles.choiceIcon}>
                    <Sparkles size={20} aria-hidden />
                  </span>
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>Try the demo</span>
                    <span className={styles.choiceBody}>
                      Explore a made-up world of friends, groups and spaces. Nothing is sent
                      anywhere.
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.choice}
                  onClick={() => {
                    if (desktop) onConnect(defaultDaemonUrl);
                    else setStep('connect');
                  }}
                >
                  <span className={styles.choiceIcon}>
                    {desktop ? (
                      <Smartphone size={20} aria-hidden />
                    ) : (
                      <PlugZap size={20} aria-hidden />
                    )}
                  </span>
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>
                      {desktop ? 'Use your Signal account' : 'Connect to signal-cli'}
                    </span>
                    <span className={styles.choiceBody}>
                      {desktop
                        ? 'Link this computer to your phone with a QR code. Nothing to install: Snowdrop runs signal-cli for you.'
                        : 'Use your real account through a signal-cli daemon running on this computer.'}
                    </span>
                  </span>
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.back}
                onClick={() => {
                  setStep('choose');
                }}
              >
                <ArrowLeft size={16} aria-hidden />
                Back
              </button>
              <ConnectForm defaultUrl={defaultDaemonUrl} onConnect={onConnect} probe={probe} />
            </>
          )}
          <p className={styles.footnote}>
            Works with Signal through signal-cli. Snowdrop is an independent project, not made by or
            affiliated with Signal.
          </p>
        </div>
      </main>
    </TooltipProvider>
  );
}
