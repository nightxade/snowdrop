import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/primitives';
import { formatClock } from './format';
import type { VoicePhase } from './useVoiceRecorder';
import { VoicePlayer } from './VoicePlayer';
import styles from './VoiceBars.module.css';

/** The bars drawn at once; wider than any composer, the container clips the rest. */
const LEVELS_SHOWN = 120;

function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === 0) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      window.clearInterval(id);
    };
  }, [startedAt]);
  return startedAt === 0 ? 0 : Math.max(0, (now - startedAt) / 1000);
}

export interface VoiceRecorderBarProps {
  phase: Exclude<VoicePhase, 'idle'>;
  levels: readonly number[];
  startedAt: number;
  onCancel: () => void;
  onSend: () => void;
}

/** The composer while recording: timer, live level, Cancel, Send. */
export function VoiceRecorderBar({
  phase,
  levels,
  startedAt,
  onCancel,
  onSend,
}: VoiceRecorderBarProps) {
  const seconds = useElapsedSeconds(startedAt);
  const bar = useRef<HTMLDivElement>(null);
  // The keyboard continues from here: the button that started this is gone.
  useEffect(() => {
    bar.current?.focus();
  }, []);
  return (
    <>
      <div
        ref={bar}
        className={styles.bar}
        role="group"
        aria-label="Voice message recorder"
        aria-busy={phase === 'starting'}
        tabIndex={-1}
        data-starting={phase === 'starting' ? '' : undefined}
      >
        <span className={styles.dot} aria-hidden />
        <span className={styles.timer} role="timer" aria-label="Recording time">
          {formatClock(seconds)}
        </span>
        <div className={styles.levels} aria-hidden>
          {levels
            .slice(-LEVELS_SHOWN)
            .toReversed()
            .map((level, i) => (
              <span
                key={i}
                className={styles.level}
                style={{ '--level-height': `${Math.round((level / 255) * 100)}%` } as never}
              />
            ))}
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={phase !== 'recording'}
            onClick={onSend}
            aria-label="Send voice message"
          >
            Send
          </Button>
        </div>
        <span className={styles.srOnly} role="status">
          {phase === 'starting'
            ? 'Starting the microphone'
            : 'Recording voice message. Press Escape to cancel.'}
        </span>
      </div>
      <p className={styles.hint}>
        Voice messages are limited to one hour. Recording stops if you switch to another app.
      </p>
    </>
  );
}

export interface VoiceDraftBarProps {
  playKey: string;
  url: string;
  levels: readonly number[];
  duration: number;
  onCancel: () => void;
  onSend: () => void;
}

/** A finished recording waiting in the composer: listen, then Send or Cancel. */
export function VoiceDraftBar({
  playKey,
  url,
  levels,
  duration,
  onCancel,
  onSend,
}: VoiceDraftBarProps) {
  return (
    <div className={styles.bar}>
      <VoicePlayer
        variant="draft"
        playKey={playKey}
        url={url}
        barCount={64}
        waveform={{ keys: [`url:${url}`], known: { levels, duration } }}
        duration={duration}
      />
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onSend} aria-label="Send voice message">
          Send
        </Button>
      </div>
    </div>
  );
}
