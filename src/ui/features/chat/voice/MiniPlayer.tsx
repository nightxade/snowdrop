import { Pause, Play, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { sessionSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { formatClock, spokenClock } from './format';
import { usePlaybackGuard } from './playbackGuard';
import {
  nextPlaybackRate,
  voicePlayback as sharedPlayback,
  type VoicePlayback,
} from './voicePlayback';
import styles from './MiniPlayer.module.css';

/**
 * The voice note that is playing, wherever you are in the app (Signal
 * Desktop's mini player): who it is from and how far along, with play/pause,
 * speed and close. It sits under the chat header, over whichever conversation
 * is open, or the empty pane, and is absent when nothing plays.
 */
export function MiniPlayer({ playback = sharedPlayback }: { playback?: VoicePlayback }) {
  const stores = useStores();
  usePlaybackGuard(playback);
  const active = useSyncExternalStore(playback.subscribe, () => playback.active);
  const rate = useSyncExternalStore(playback.subscribe, () => playback.rate);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const authorId = active?.source?.authorId;
  const name = useStore(stores.contacts, (s) => (authorId ? s.byId[authorId]?.name : undefined));
  if (!active) return null;

  const title =
    authorId === undefined
      ? 'Voice message'
      : authorId === selfId
        ? 'You'
        : (name ?? 'Unknown contact');
  const playing = active.playing || active.pending;
  const loading = active.pending && !active.playing;
  return (
    <div className={styles.bar} role="group" aria-label="Voice message playing">
      <button
        type="button"
        className={styles.toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        aria-busy={loading ? true : undefined}
        onClick={() => {
          if (playing) playback.pause();
          else playback.resume();
        }}
      >
        {playing ? (
          <Pause fill="currentColor" aria-hidden />
        ) : (
          <Play fill="currentColor" aria-hidden />
        )}
      </button>
      <div className={styles.state}>
        <span className={styles.title}>{title}</span>
        <span className={styles.dot} aria-hidden>
          ·
        </span>
        <span className={styles.time} aria-label={spokenClock(active.currentTime)}>
          {formatClock(active.currentTime)}
        </span>
      </div>
      {active.playing && (
        <button
          type="button"
          className={styles.rate}
          aria-label={`Playback speed ${rate}x. Change speed`}
          onClick={() => {
            playback.setRate(nextPlaybackRate(rate));
          }}
        >
          {rate}×
        </button>
      )}
      <button
        type="button"
        className={styles.close}
        aria-label="Close voice message player"
        onClick={() => {
          playback.stop();
        }}
      >
        <X aria-hidden />
      </button>
    </div>
  );
}
