/**
 * Loudness bars for voice notes: the live level while recording, and the
 * waveform drawn on playback. Signal carries no waveform with a voice note, so
 * every client computes its own from the audio.
 */

/** Bars a finished waveform has (the recorder and the decoder both reduce to this). */
export const WAVEFORM_BINS = 100;

/** Anything quieter than this reads as silence. */
const NOISE_FLOOR_DB = -60;

/** A mean-square power (0..1) as a level from 0 (silence) to 255 (full scale). */
export function toLevel(meanSquare: number): number {
  if (!(meanSquare > 0)) return 0;
  const fraction = Math.max(0, 10 * Math.log10(meanSquare) - NOISE_FLOOR_DB) / -NOISE_FLOOR_DB;
  return Math.round(Math.min(1, fraction) * 255);
}

export function meanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return sum / samples.length;
}

/**
 * Reduces any number of samples to at most `WAVEFORM_BINS` levels as they
 * arrive, so a recording of unknown length needs no buffer of its own: when the
 * bins fill up, neighbours merge and each bin covers twice the samples.
 */
export class WaveformBuilder {
  /** Sum of squares per bin; the last bin may be partial. */
  private sums: number[] = [0];
  private counts: number[] = [0];
  private binSize = 1;

  push(samples: Float32Array): void {
    for (const s of samples) {
      let last = this.sums.length - 1;
      if ((this.counts[last] ?? 0) >= this.binSize) {
        if (this.sums.length >= WAVEFORM_BINS) {
          this.merge();
          last = this.sums.length - 1;
        } else {
          this.sums.push(0);
          this.counts.push(0);
          last += 1;
        }
      }
      this.sums[last] = (this.sums[last] ?? 0) + s * s;
      this.counts[last] = (this.counts[last] ?? 0) + 1;
    }
  }

  /** Pairs of bins become one; the bin size doubles. */
  private merge(): void {
    const sums: number[] = [];
    const counts: number[] = [];
    for (let i = 0; i < this.sums.length; i += 2) {
      sums.push((this.sums[i] ?? 0) + (this.sums[i + 1] ?? 0));
      counts.push((this.counts[i] ?? 0) + (this.counts[i + 1] ?? 0));
    }
    this.sums = sums;
    this.counts = counts;
    this.binSize *= 2;
  }

  /** The levels so far (0..255 each); a partial last bin counts for what it holds. */
  collect(): number[] {
    return this.sums.flatMap((sum, i) => {
      const count = this.counts[i] ?? 0;
      return count > 0 ? [toLevel(sum / count)] : [];
    });
  }
}

/** Levels of a decoded clip (channels are folded into the same bins). */
export function waveformOf(channels: readonly Float32Array[]): number[] {
  const builder = new WaveformBuilder();
  const length = Math.max(0, ...channels.map((c) => c.length));
  for (let offset = 0; offset < length; offset += 16_384) {
    for (const channel of channels) builder.push(channel.subarray(offset, offset + 16_384));
  }
  return builder.collect();
}

/** Resamples levels to exactly `bars` bars (mean of the levels each bar covers), scaled to 0..1. */
export function barsOf(levels: readonly number[], bars: number): number[] {
  if (bars <= 0) return [];
  if (levels.length === 0) return Array.from({ length: bars }, () => 0);
  const out: number[] = [];
  const stride = levels.length / bars;
  for (let i = 0; i < bars; i++) {
    const from = Math.floor(i * stride);
    const to = Math.max(from + 1, Math.floor((i + 1) * stride));
    let sum = 0;
    for (let j = from; j < to && j < levels.length; j++) sum += levels[j] ?? 0;
    out.push(sum / (to - from) / 255);
  }
  return out;
}
