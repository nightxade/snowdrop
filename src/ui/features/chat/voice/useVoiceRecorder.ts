import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RecordingCancelled,
  VoiceRecorder,
  VoiceRecorderError,
  type RecorderDeps,
  type VoiceRecording,
} from './recorder';
import { createMp3Encoder } from './mp3Encoder';
import { createWebAudioCapture, openMicrophone } from './webAudioCapture';

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'finishing';

/** What happens to a finished recording: it goes out, or waits in the composer to be sent or dropped. */
export type VoiceOutcome = 'send' | 'draft';

/** The most levels kept for the live display (about 40 s at ten a second is plenty to scroll through). */
const MAX_LEVELS = 400;

export const defaultRecorderDeps: RecorderDeps = {
  openStream: openMicrophone,
  createCapture: createWebAudioCapture,
  createEncoder: createMp3Encoder,
};

export interface UseVoiceRecorder {
  phase: VoicePhase;
  /** Loudness of the most recent blocks, oldest first, 0..255. */
  levels: readonly number[];
  /** When recording began (`Date.now()`), 0 until it has. */
  startedAt: number;
  start: () => void;
  /** Stops and hands the recording over: `send` goes out, `draft` waits in the composer. */
  finish: (outcome: VoiceOutcome) => void;
  /** Throws it away and turns the microphone off. */
  cancel: () => void;
}

export interface UseVoiceRecorderOptions {
  onRecorded: (recording: VoiceRecording, outcome: VoiceOutcome, limit: boolean) => void;
  onError: (message: string) => void;
  deps?: RecorderDeps;
}

/**
 * The composer's recorder: one microphone, never left open. Leaving (the
 * composer unmounts when the conversation changes), cancelling, a failure and
 * finishing all end with the microphone off. The window losing focus keeps the
 * recording as a draft, as Signal Desktop does.
 */
export function useVoiceRecorder({
  onRecorded,
  onError,
  deps = defaultRecorderDeps,
}: UseVoiceRecorderOptions): UseVoiceRecorder {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const recorder = useRef<VoiceRecorder | null>(null);
  const alive = useRef(true);
  const phaseRef = useRef<VoicePhase>('idle');
  const handlers = useRef({ onRecorded, onError });
  useEffect(() => {
    handlers.current = { onRecorded, onError };
  });
  const move = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      recorder.current?.cancel();
    };
  }, []);

  const finish = useCallback(
    (outcome: VoiceOutcome, limit = false) => {
      const current = recorder.current;
      if (!current || phaseRef.current !== 'recording') return;
      move('finishing');
      current.stop().then(
        (recording) => {
          if (!alive.current) return;
          move('idle');
          setLevels([]);
          handlers.current.onRecorded(recording, outcome, limit);
        },
        (error: unknown) => {
          if (!alive.current || error instanceof RecordingCancelled) return;
          move('idle');
          setLevels([]);
          handlers.current.onError(
            error instanceof VoiceRecorderError
              ? error.message
              : new VoiceRecorderError('failed').message,
          );
        },
      );
    },
    [move],
  );

  const start = useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    const current = (recorder.current ??= new VoiceRecorder(deps));
    move('starting');
    setLevels([]);
    setStartedAt(0);
    current
      .start({
        onLevel: (level) => {
          setLevels((previous) => [...previous.slice(1 - MAX_LEVELS), level]);
        },
        // The cap keeps what was recorded; it waits in the composer to be sent or dropped.
        onLimit: () => {
          finish('draft', true);
        },
      })
      .then(
        () => {
          if (!alive.current) return;
          setStartedAt(Date.now());
          move('recording');
        },
        (error: unknown) => {
          if (!alive.current || error instanceof RecordingCancelled) return;
          move('idle');
          handlers.current.onError(
            error instanceof VoiceRecorderError
              ? error.message
              : new VoiceRecorderError('failed').message,
          );
        },
      );
  }, [deps, finish, move]);

  const cancel = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    recorder.current?.cancel();
    move('idle');
    setLevels([]);
  }, [move]);

  // Switching to another app keeps what was said (the recording would otherwise run on unseen).
  useEffect(() => {
    if (phase !== 'recording') return;
    const onBlur = () => {
      finish('draft');
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
    };
  }, [phase, finish]);

  // Escape cancels, ahead of the global Escape (mark read) that would otherwise also run.
  useEffect(() => {
    if (phase === 'idle') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [phase, cancel]);

  return { phase, levels, startedAt, start, finish, cancel };
}
