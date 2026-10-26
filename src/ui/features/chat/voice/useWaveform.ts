import { useEffect, useState } from 'react';
import { cachedWaveform, loadWaveform, type WaveformInfo } from './waveformCache';

export interface WaveformSource {
  /** Cache keys for this note (most specific first). */
  keys: readonly string[];
  /** Known up front (a note we just recorded). */
  known?: WaveformInfo | undefined;
  /** Reads the note's bytes; absent means no waveform can be computed. */
  read?: (() => Promise<Blob>) | undefined;
}

/** The note's waveform: given, cached, or computed in the background (`undefined` meanwhile). */
export function useWaveform(source: WaveformSource): WaveformInfo | undefined {
  const { keys, known, read } = source;
  const identity = keys.join('\u0000');
  const [computed, setComputed] = useState<{ identity: string; info: WaveformInfo } | null>(null);
  useEffect(() => {
    if (known || !read) return;
    let cancelled = false;
    loadWaveform(keys, read).then(
      (info) => {
        if (!cancelled) setComputed({ identity, info });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // `keys` and `read` are rebuilt every render; `identity` stands for them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, Boolean(known), Boolean(read)]);
  if (known) return known;
  if (computed?.identity === identity) return computed.info;
  return cachedWaveform(keys);
}
