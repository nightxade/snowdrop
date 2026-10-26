import { vi } from 'vitest';
import type { CaptureSession, Mp3Encoder, RecorderDeps } from './recorder';

/** A microphone, audio graph and encoder that only count what is done to them. */
export interface Rig {
  deps: RecorderDeps;
  tracks: { stop: ReturnType<typeof vi.fn> }[];
  capture: CaptureSession & {
    deliver(samples: Float32Array): void;
    closed: number;
    attached: number;
  };
  encoder: Mp3Encoder & { encoded: number; finished: number };
  /** Resolves the pending `openStream()` (when `holdStream` is used). */
  release(): void;
}

export function rig(
  options: { holdStream?: boolean; sampleRate?: number; tail?: number } = {},
): Rig {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  let onBlock: ((samples: Float32Array) => void) | null = null;
  const capture = {
    sampleRate: options.sampleRate ?? 48_000,
    closed: 0,
    attached: 0,
    attach: () => {
      capture.attached++;
      return Promise.resolve();
    },
    start: (cb: (samples: Float32Array) => void) => {
      onBlock = cb;
    },
    flush: () => Promise.resolve(new Float32Array(options.tail ?? 0)),
    close: () => {
      capture.closed++;
    },
    deliver: (samples: Float32Array) => onBlock?.(samples),
  };
  const encoder = {
    encoded: 0,
    finished: 0,
    encode: (samples: Float32Array) => {
      encoder.encoded += samples.length;
      return new Uint8Array([1, 2, 3]);
    },
    finish: () => {
      encoder.finished++;
      return new Uint8Array([9]);
    },
  };
  let release: () => void = () => undefined;
  const deps: RecorderDeps = {
    openStream: () =>
      options.holdStream
        ? new Promise((resolve) => {
            release = () => {
              resolve(stream);
            };
          })
        : Promise.resolve(stream),
    createCapture: () => capture,
    createEncoder: () => Promise.resolve(encoder),
  };
  return {
    deps,
    tracks,
    capture,
    encoder,
    release: () => {
      release();
    },
  };
}
