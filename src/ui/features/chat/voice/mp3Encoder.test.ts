/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMp3Encoder } from './mp3Encoder';

// The real encoder (LAME in WebAssembly) on a real tone; only the file fetch is stood in for.
const wasm = readFileSync('node_modules/wasm-media-encoders/wasm/mp3.wasm');
const serveWasm = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(new Uint8Array(wasm), { status: 200 }))),
  );
afterEach(() => {
  vi.unstubAllGlobals();
});

function tone(seconds: number, sampleRate: number): Float32Array[] {
  const blocks: Float32Array[] = [];
  const total = Math.round(seconds * sampleRate);
  for (let at = 0; at < total; at += 4096) {
    const block = new Float32Array(Math.min(4096, total - at));
    for (let i = 0; i < block.length; i++)
      block[i] = 0.4 * Math.sin((2 * Math.PI * 440 * (at + i)) / sampleRate);
    blocks.push(block);
  }
  return blocks;
}

async function encode(seconds: number, sampleRate: number): Promise<Uint8Array> {
  const encoder = await createMp3Encoder(sampleRate);
  const parts = [...tone(seconds, sampleRate).map((b) => encoder.encode(b)), encoder.finish()];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('createMp3Encoder', () => {
  it('writes a playable MPEG audio stream at a constant 96 kbit/s, mono', async () => {
    serveWasm();
    const mp3 = await encode(4, 44_100);
    // A frame header: 11 sync bits, MPEG-1 layer III, 96 kbit/s, 44.1 kHz, mono.
    expect(mp3[0]).toBe(0xff);
    expect((mp3[1] ?? 0) & 0xfe).toBe(0xfa);
    expect((mp3[2] ?? 0) >> 4).toBe(0b0111);
    expect(((mp3[3] ?? 0) >> 6) & 3).toBe(0b11);
    // ~12 kB per second at 96 kbit/s.
    expect(mp3.length).toBeGreaterThan(4 * 11_000);
    expect(mp3.length).toBeLessThan(4 * 13_000);
  });

  it('copies each chunk out of the encoder, whose buffer is reused', async () => {
    serveWasm();
    const encoder = await createMp3Encoder(48_000);
    const [first, second] = tone(2, 48_000);
    const a = encoder.encode(first as Float32Array);
    const snapshot = a.slice();
    encoder.encode(second as Float32Array);
    expect(a).toEqual(snapshot);
  });

  it('resamples a rate MP3 cannot be written at', async () => {
    serveWasm();
    const mp3 = await encode(2, 96_000);
    // 48 kHz, MPEG-1: sampling-rate bits 01.
    expect(((mp3[2] ?? 0) >> 2) & 3).toBe(0b01);
  });

  it('does not remember a failed load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 }))),
    );
    // A fresh module: the compiled encoder of the other tests is not remembered here.
    vi.resetModules();
    const fresh = await import('./mp3Encoder');
    await expect(fresh.createMp3Encoder(44_100)).rejects.toThrow();
    serveWasm();
    await expect(fresh.createMp3Encoder(44_100)).resolves.toBeTruthy();
  });
});
