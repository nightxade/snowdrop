import { ArrowLeft, PlugZap, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { HearthMark, TooltipProvider } from '@/ui/primitives';
import { ConnectForm } from './ConnectForm';
import styles from './Welcome.module.css';

export interface WelcomeProps {
  /** Start the demo world. */
  onDemo: () => void;
  /** Save the daemon URL and connect to signal-cli. */
  onConnect: (daemonUrl: string) => void;
  defaultDaemonUrl: string;
}

/** First run (PLAN §4.10): the one screen where the brand gets room to breathe. */
export function Welcome({ onDemo, onConnect, defaultDaemonUrl }: WelcomeProps) {
  const [step, setStep] = useState<'choose' | 'connect'>('choose');
  return (
    <TooltipProvider>
      <main className={styles.screen} data-hearth="welcome">
        <div className={styles.glow} aria-hidden />
        <div className={styles.column}>
          <div className={styles.brand}>
            <HearthMark size={48} className={styles.mark} />
            <h1 className={styles.wordmark}>Hearth</h1>
          </div>
          {step === 'choose' ? (
            <>
              <p className={styles.lede}>
                Your Signal conversations, arranged like a community: spaces for your groups, a
                sidebar for everything else, and a keyboard for all of it.
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
                    setStep('connect');
                  }}
                >
                  <span className={styles.choiceIcon}>
                    <PlugZap size={20} aria-hidden />
                  </span>
                  <span className={styles.choiceText}>
                    <span className={styles.choiceTitle}>Connect to signal-cli</span>
                    <span className={styles.choiceBody}>
                      Use your real account through a signal-cli daemon running on this computer.
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
              <ConnectForm defaultUrl={defaultDaemonUrl} onConnect={onConnect} />
            </>
          )}
          <p className={styles.footnote}>
            Works with Signal through signal-cli. Hearth is an independent project, not made by or
            affiliated with Signal. Everything stays on this device.
          </p>
        </div>
      </main>
    </TooltipProvider>
  );
}
