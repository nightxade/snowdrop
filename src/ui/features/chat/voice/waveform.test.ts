import { describe, expect, it } from 'vitest';
import {
  barsOf,
  meanSquare,
  toLevel,
  WAVEFORM_BINS,
  WaveformBuilder,
  waveformOf,
} from './waveform';

describe('levels', () => {
  it('maps silence to 0 and full scale to 255, loudness in decibels in between', () => {
    expect(toLevel(0)).toBe(0);
    expect(toLevel(1e-9)).toBe(0);
    expect(toLevel(1)).toBe(255);
    // -30 dB is halfway up a 60 dB range.
    expect(toLevel(10 ** -3)).toBe(128);
  });

  it('is the mean square of the samples', () => {
    expect(meanSquare(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(meanSquare(new Float32Array(0))).toBe(0);
  });
});

describe('WaveformBuilder', () => {
  it('never holds more than the bin limit, however long the clip', () => {
    const builder = new WaveformBuilder();
    builder.push(new Float32Array(WAVEFORM_BINS * 37 + 5).fill(0.5));
    const levels = builder.collect();
    expect(levels.length).toBeLessThanOrEqual(WAVEFORM_BINS);
    expect(levels.length).toBeGreaterThan(WAVEFORM_BINS / 2);
    for (const level of levels) expect(level).toBe(toLevel(0.25));
  });

  it('keeps the shape: a quiet half then a loud half', () => {
    const builder = new WaveformBuilder();
    builder.push(new Float32Array(10_000).fill(0.01));
    builder.push(new Float32Array(10_000).fill(0.9));
    const levels = builder.collect();
    const half = Math.floor(levels.length / 2);
    expect(Math.max(...levels.slice(0, half - 2))).toBeLessThan(
      Math.min(...levels.slice(half + 2)),
    );
  });

  it('gives one level per sample for a very short clip, and none for none', () => {
    expect(new WaveformBuilder().collect()).toEqual([]);
    const builder = new WaveformBuilder();
    builder.push(new Float32Array([1, 0.5]));
    expect(builder.collect()).toHaveLength(2);
  });

  it('folds every channel of a decoded clip', () => {
    const levels = waveformOf([new Float32Array(1000).fill(0.5), new Float32Array(1000).fill(0.5)]);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.length).toBeLessThanOrEqual(WAVEFORM_BINS);
  });
});

describe('barsOf', () => {
  it('resamples to the requested number of bars, 0..1', () => {
    const bars = barsOf([0, 255, 0, 255], 2);
    expect(bars).toEqual([0.5, 0.5]);
    expect(barsOf([255], 3)).toEqual([1, 1, 1]);
  });
  it('is flat with nothing to show', () => {
    expect(barsOf([], 4)).toEqual([0, 0, 0, 0]);
    expect(barsOf([1, 2], 0)).toEqual([]);
  });
});
