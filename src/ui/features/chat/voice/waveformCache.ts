/**
 * Waveforms of voice notes, computed on this device when a note is shown (the
 * file is decoded off-screen) and remembered, so scrolling back doesn't decode
 * it again. A recording we just made seeds its own entry instead.
 */
import { waveformOf } from './waveform';

export interface WaveformInfo {
  /** Levels, 0..255 each. Empty when the clip is too long to be worth decoding. */
  levels: readonly number[];
  /** Seconds. */
  duration: number;
}

/** Longer clips are not decoded (the audio stays playable; the bars stay flat). */
export const MAX_DECODE_SECONDS = 15 * 60;
const MAX_ENTRIES = 1000;
const MAX_PARALLEL = 3;

const cache = new Map<string, WaveformInfo>();
const pending = new Map<string, Promise<WaveformInfo>>();
const waiting: (() => void)[] = [];
let running = 0;

export function cachedWaveform(keys: readonly string[]): WaveformInfo | undefined {
  for (const key of keys) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  return undefined;
}

export function rememberWaveform(keys: readonly string[], info: WaveformInfo): void {
  for (const key of keys) {
    cache.delete(key);
    cache.set(key, info);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Forgets everything (tests; and nothing else needs to). */
export function clearWaveformCache(): void {
  cache.clear();
  pending.clear();
}

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Decodes `blob` and reduces it to a waveform; rejects when the browser can't read it. */
export async function decodeWaveform(blob: Blob): Promise<WaveformInfo> {
  const bytes = await blob.arrayBuffer();
  // Offline: no sound device, no autoplay rules, and nothing to close.
  const context = new OfflineAudioContext(1, 1, 44_100);
  const audio = await context.decodeAudioData(bytes);
  if (audio.duration > MAX_DECODE_SECONDS) return { levels: [], duration: audio.duration };
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  return { levels: waveformOf(channels), duration: audio.duration };
}

/**
 * The waveform for a note, from the cache or by reading and decoding its
 * bytes (`read`). One decode per `keys[0]` at a time, a few at once overall.
 */
export function loadWaveform(
  keys: readonly string[],
  read: () => Promise<Blob>,
): Promise<WaveformInfo> {
  const hit = cachedWaveform(keys);
  if (hit) return Promise.resolve(hit);
  const id = keys[0] ?? '';
  const running = pending.get(id);
  if (running) return running;
  const job = slot(async () => decodeWaveform(await read()))
    .then((info) => {
      rememberWaveform(keys, info);
      return info;
    })
    .finally(() => {
      pending.delete(id);
    });
  pending.set(id, job);
  return job;
}
