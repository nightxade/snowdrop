/**
 * The MP3 encoder: LAME compiled to WebAssembly (`wasm-media-encoders`, MIT;
 * LAME itself is LGPL-2.0-or-later, see THIRD_PARTY_NOTICES). Bundled, no CDN: the
 * `.wasm` file ships next to the app as its own asset, fetched from the app's
 * own origin the first time someone records, and the encoder code is a separate
 * lazy chunk so it never loads for people who don't.
 *
 * Mono, constant 96 kbit/s: Signal Desktop's voice notes are mono MP3 at about
 * 90 kbit/s, and 96 is the nearest rate MP3 defines (LAME's constant-rate mode
 * takes only the standard rates). A constant rate also lets a player work out
 * the length from the file size, as the encoder writes no length header.
 */
import mp3WasmUrl from 'wasm-media-encoders/wasm/mp3?url';
import type { Mp3Encoder } from './recorder';

const BITRATE_KBPS = 96;
/** The rates MPEG audio layer III can be written at. */
const MP3_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);

let compiled: Promise<WebAssembly.Module> | undefined;

/** The encoder module, compiled once (it needs `'wasm-unsafe-eval'` in the CSP). */
function compiledModule(): Promise<WebAssembly.Module> {
  compiled ??= fetch(mp3WasmUrl)
    .then((response) => {
      if (!response.ok) throw new Error('The MP3 encoder could not be loaded.');
      return response.arrayBuffer();
    })
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error: unknown) => {
      // A failure (offline dev server, say) must not be remembered forever.
      compiled = undefined;
      throw error;
    });
  return compiled;
}

export async function createMp3Encoder(sampleRate: number): Promise<Mp3Encoder> {
  const [{ createEncoder }, module] = await Promise.all([
    import('./encoderCore'),
    compiledModule(),
  ]);
  const encoder = await createEncoder('audio/mpeg', module);
  encoder.configure({
    sampleRate,
    channels: 1,
    bitrate: BITRATE_KBPS,
    // LAME resamples when the microphone runs at a rate MP3 can't be written at.
    ...(MP3_RATES.has(sampleRate) ? {} : { outputSampleRate: 48_000 as const }),
  });
  return {
    // The encoder's output buffer is reused by its next call: copy it out.
    encode: (samples) => encoder.encode([samples]).slice(),
    finish: () => encoder.finalize().slice(),
  };
}
