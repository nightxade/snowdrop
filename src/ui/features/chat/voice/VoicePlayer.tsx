import { Pause, Play } from 'lucide-react';
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { formatClock, spokenClock } from './format';
import {
  nextPlaybackRate,
  voicePlayback as sharedPlayback,
  type VoicePlayback,
} from './voicePlayback';
import { barsOf } from './waveform';
import { useWaveform, type WaveformSource } from './useWaveform';
import styles from './VoicePlayer.module.css';

/** Keeps pointer events coming while a drag leaves the bars (not every webview has it). */
function capture(event: PointerEvent, on: boolean): void {
  try {
    if (on) event.currentTarget.setPointerCapture(event.pointerId);
    else event.currentTarget.releasePointerCapture(event.pointerId);
  } catch {
    // The pointer is already gone; the drag simply ends.
  }
}

const BAR_MIN = 3;
const BAR_MAX = 24;
/** A press this close to the start rewinds to the very start (47 bars; the first two). */
const REWIND_FRACTION = 2 / 47;
const SMALL_STEP = 1;
const BIG_STEP = 5;

export interface VoicePlayerProps {
  /** Identifies this note to the shared player (and to autoplay). */
  playKey: string;
  /** The audio, already resolved. */
  url: string;
  waveform: WaveformSource;
  /** Seconds, if the sender's file is known to be this long before it loads. */
  duration?: number | undefined;
  /** What to show in place of the length until it is known. */
  sizeText?: string | undefined;
  /** Someone else's note you haven't played yet. */
  unplayed?: boolean | undefined;
  onPlayed?: (() => void) | undefined;
  /** The key of the voice note after this one, for autoplay. */
  nextKey?: (() => string | undefined) | undefined;
  variant?: 'message' | 'draft';
  barCount?: number;
  /** The player that owns the sound; the app's shared one unless a test supplies its own. */
  playback?: VoicePlayback;
}

export function VoicePlayer({
  playKey,
  url,
  waveform,
  duration: givenDuration,
  sizeText,
  unplayed = false,
  onPlayed,
  nextKey,
  variant = 'message',
  barCount = 47,
  playback: voicePlayback = sharedPlayback,
}: VoicePlayerProps) {
  const active = useSyncExternalStore(voicePlayback.subscribe, () =>
    voicePlayback.snapshot(playKey),
  );
  const failed = useSyncExternalStore(
    voicePlayback.subscribe,
    () => voicePlayback.failedKey === playKey,
  );
  const rate = useSyncExternalStore(voicePlayback.subscribe, () => voicePlayback.rate);
  const info = useWaveform(waveform);
  const duration = info?.duration ?? active?.duration ?? givenDuration;
  const currentTime = active?.currentTime ?? 0;
  // Pressed means pressed: the button answers at once, even while the webview opens the file.
  const playing = (active?.playing || active?.pending) ?? false;
  const ratio = duration && duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const bars = barsOf(info?.levels ?? [], barCount);
  const scrubber = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const start = (startRatio?: number) => {
    voicePlayback.play({
      key: playKey,
      url,
      ...(startRatio !== undefined ? { startRatio } : {}),
      ...(nextKey ? { nextKey } : {}),
      ...(onPlayed ? { onStart: onPlayed } : {}),
    });
  };
  // Autoplay starts this note from the shared player: always with the latest props.
  const latest = useRef(start);
  useEffect(() => {
    latest.current = start;
  });
  useEffect(
    () =>
      voicePlayback.registerStarter(playKey, () => {
        latest.current(0);
      }),
    [playKey, voicePlayback],
  );
  // Gone from the list (scrolled away, conversation closed): its sound goes with it.
  useEffect(
    () => () => {
      voicePlayback.release(playKey);
    },
    [playKey, voicePlayback],
  );

  const toggle = () => {
    if (playing) voicePlayback.pause();
    else start();
  };

  /** Jumps to `target` (0..1) and plays, as pressing the bars does in Signal Desktop. */
  const jump = (target: number) => {
    const clamped = Math.min(1, Math.max(0, target));
    if (active) {
      voicePlayback.seek(clamped);
      if (!playing) start();
    } else {
      start(clamped);
    }
  };

  const ratioAt = (clientX: number): number => {
    const box = scrubber.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    const at = (clientX - box.left) / box.width;
    return at <= REWIND_FRACTION ? 0 : at;
  };

  const step = (seconds: number) => {
    if (!duration) return;
    jump((currentTime + seconds) / duration);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const steps: Record<string, number> = {
      ArrowRight: SMALL_STEP,
      ArrowUp: SMALL_STEP,
      ArrowLeft: -SMALL_STEP,
      ArrowDown: -SMALL_STEP,
      PageUp: BIG_STEP,
      PageDown: -BIG_STEP,
    };
    const delta = steps[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      step(delta);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      jump(event.key === 'Home' ? 0 : 1);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragging.current = true;
    capture(event, true);
    jump(ratioAt(event.clientX));
  };
  const onPointerMove = (event: PointerEvent) => {
    if (dragging.current && voicePlayback.snapshot(playKey)) {
      voicePlayback.seek(ratioAt(event.clientX));
    }
  };
  const onPointerEnd = (event: PointerEvent) => {
    dragging.current = false;
    capture(event, false);
  };

  const remaining = duration !== undefined ? Math.max(0, duration - currentTime) : undefined;
  const timeText =
    duration !== undefined && duration > 0
      ? formatClock(active ? (remaining ?? 0) : duration)
      : (sizeText ?? '');
  const playedBars = Math.round(ratio * bars.length);

  return (
    <div className={styles.player} data-variant={variant} role="group" aria-label="Voice message">
      <button
        type="button"
        className={styles.toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        aria-busy={active?.pending && !active.playing ? true : undefined}
        data-voice-toggle
        onClick={toggle}
      >
        {playing ? (
          <Pause fill="currentColor" aria-hidden />
        ) : (
          <Play fill="currentColor" aria-hidden />
        )}
      </button>
      <div
        ref={scrubber}
        className={styles.scrubber}
        data-pending={info ? undefined : ''}
        role="slider"
        tabIndex={0}
        aria-label="Voice message position"
        aria-valuemin={0}
        aria-valuemax={Math.max(1, Math.round(duration ?? 1))}
        aria-valuenow={Math.min(Math.round(currentTime), Math.max(1, Math.round(duration ?? 1)))}
        aria-valuetext={
          duration !== undefined
            ? `${spokenClock(currentTime)} of ${spokenClock(duration)}`
            : spokenClock(currentTime)
        }
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {bars.map((level, i) => (
          <span
            key={i}
            className={styles.bar}
            data-played={i < playedBars ? '' : undefined}
            style={{ '--bar-height': `${BAR_MIN + level * (BAR_MAX - BAR_MIN)}px` } as never}
            aria-hidden
          />
        ))}
      </div>
      <div className={styles.meta}>
        {failed ? (
          <span className={styles.problem} role="status">
            Can&apos;t play this
          </span>
        ) : (
          <span className={styles.time} data-unplayed={unplayed ? '' : undefined}>
            {timeText}
          </span>
        )}
        {unplayed && (
          <>
            <span className={styles.dot} aria-hidden />
            <span className={styles.srOnly}>Not played yet</span>
          </>
        )}
        {active && (
          <button
            type="button"
            className={styles.rate}
            aria-label={`Playback speed ${rate}x. Change speed`}
            onClick={() => {
              voicePlayback.setRate(nextPlaybackRate(rate));
            }}
          >
            {rate}×
          </button>
        )}
      </div>
    </div>
  );
}
