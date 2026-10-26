import { describe, expect, it, vi } from 'vitest';
import { rig, type Rig } from './fakeRecorder';
import { VOICE_NOTE_MAX_SECONDS } from '@/core/domain';
import {
  RecordingCancelled,
  VoiceRecorder,
  VoiceRecorderError,
  classifyMicrophoneError,
  type Mp3Encoder,
} from './recorder';

const stopped = (r: Rig) => r.tracks.every((t) => t.stop.mock.calls.length > 0);

describe('VoiceRecorder', () => {
  it('records, encodes every block and returns an MP3 with its length and waveform', async () => {
    const r = rig({ tail: 100 });
    const recorder = new VoiceRecorder(r.deps);
    const levels: number[] = [];
    await recorder.start({ onLevel: (l) => levels.push(l) });
    expect(recorder.state).toBe('recording');
    r.capture.deliver(new Float32Array(48_000).fill(0.5));
    const recording = await recorder.stop();
    expect(recorder.state).toBe('idle');
    expect(recording.blob.type).toBe('audio/mpeg');
    // Three bytes for the block, three for the tail, one for the final frame.
    expect(recording.blob.size).toBe(7);
    expect(recording.durationSeconds).toBeCloseTo((48_000 + 100) / 48_000, 5);
    expect(recording.waveform.length).toBeGreaterThan(0);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeGreaterThan(200);
    expect(r.encoder.finished).toBe(1);
  });

  it('builds the audio graph synchronously, while the click that started it is still current', () => {
    const r = rig({ holdStream: true });
    const created = vi.spyOn(r.deps, 'createCapture');
    const recorder = new VoiceRecorder(r.deps);
    void recorder.start().catch(() => undefined);
    // Nothing has been awaited yet: a webview only starts an audio context made right now.
    expect(created).toHaveBeenCalledOnce();
    expect(r.capture.attached).toBe(0);
    recorder.cancel();
  });

  it('loads the encoder while the permission is still being asked for', () => {
    const r = rig({ holdStream: true });
    const encoder = vi.spyOn(r.deps, 'createEncoder');
    const recorder = new VoiceRecorder(r.deps);
    void recorder.start().catch(() => undefined);
    expect(encoder).toHaveBeenCalledWith(48_000);
    recorder.cancel();
  });

  it('gives up cleanly when the audio graph cannot be built at all', async () => {
    const r = rig();
    r.deps.createCapture = () => {
      throw new Error('no AudioContext');
    };
    const recorder = new VoiceRecorder(r.deps);
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'failed' });
    expect(recorder.state).toBe('idle');
  });

  it('turns the microphone off as soon as it stops, and tears the audio graph down', async () => {
    const r = rig();
    const recorder = new VoiceRecorder(r.deps);
    await recorder.start();
    expect(stopped(r)).toBe(false);
    await recorder.stop();
    expect(stopped(r)).toBe(true);
    expect(r.capture.closed).toBe(1);
  });

  it('turns the microphone off on cancel', async () => {
    const r = rig();
    const recorder = new VoiceRecorder(r.deps);
    await recorder.start();
    recorder.cancel();
    expect(stopped(r)).toBe(true);
    expect(r.capture.closed).toBe(1);
    expect(recorder.state).toBe('idle');
    // Samples that arrive late are ignored.
    r.capture.deliver(new Float32Array(10));
    expect(r.encoder.encoded).toBe(0);
  });

  it('cancelled while the microphone is still opening: releases it the moment it arrives', async () => {
    const r = rig({ holdStream: true });
    const recorder = new VoiceRecorder(r.deps);
    const started = recorder.start();
    expect(recorder.state).toBe('starting');
    recorder.cancel();
    expect(recorder.state).toBe('idle');
    r.release();
    await expect(started).rejects.toBeInstanceOf(RecordingCancelled);
    expect(stopped(r)).toBe(true);
    // The audio graph was built at once and is torn down too.
    expect(r.capture.closed).toBeGreaterThan(0);
  });

  it('cancelled while the encoder loads: releases the microphone and the graph', async () => {
    const r = rig();
    let finish: (encoder: Mp3Encoder) => void = () => undefined;
    r.deps.createEncoder = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const recorder = new VoiceRecorder(r.deps);
    const started = recorder.start();
    await vi.waitFor(() => {
      expect(recorder.state).toBe('starting');
      expect(r.tracks[0]?.stop).not.toHaveBeenCalled();
    });
    await Promise.resolve();
    recorder.cancel();
    finish(r.encoder);
    await expect(started).rejects.toBeInstanceOf(RecordingCancelled);
    expect(stopped(r)).toBe(true);
    expect(r.capture.closed).toBeGreaterThan(0);
  });

  it('releases the microphone when the audio graph fails to open', async () => {
    const r = rig();
    r.capture.attach = () => Promise.reject(new Error('no worklet'));
    const recorder = new VoiceRecorder(r.deps);
    await expect(recorder.start()).rejects.toMatchObject({ kind: 'failed' });
    expect(stopped(r)).toBe(true);
    expect(recorder.state).toBe('idle');
  });

  it('releases the microphone when the encoder fails to load', async () => {
    const r = rig();
    r.deps.createEncoder = () => Promise.reject(new Error('no wasm'));
    const recorder = new VoiceRecorder(r.deps);
    await expect(recorder.start()).rejects.toBeInstanceOf(VoiceRecorderError);
    expect(stopped(r)).toBe(true);
    expect(r.capture.closed).toBe(1);
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no-device'],
    ['OverconstrainedError', 'no-device'],
    ['NotReadableError', 'failed'],
  ])('classifies %s as %s', async (name, kind) => {
    expect(classifyMicrophoneError(new DOMException('x', name))).toBe(kind);
    const r = rig();
    r.deps.openStream = () => Promise.reject(new DOMException('x', name));
    const recorder = new VoiceRecorder(r.deps);
    await expect(recorder.start()).rejects.toMatchObject({ kind });
    expect(recorder.state).toBe('idle');
  });

  it('says so when the webview has no microphone support', () => {
    expect(classifyMicrophoneError(new DOMException('x', 'NotSupportedError'))).toBe('failed');
  });

  it('refuses to start twice, and to stop when nothing records', async () => {
    const r = rig();
    const recorder = new VoiceRecorder(r.deps);
    await expect(recorder.stop()).rejects.toBeInstanceOf(VoiceRecorderError);
    await recorder.start();
    await expect(recorder.start()).rejects.toBeInstanceOf(VoiceRecorderError);
    recorder.cancel();
  });

  it('can record again after a recording and after a cancel', async () => {
    const r = rig();
    const recorder = new VoiceRecorder(r.deps);
    await recorder.start();
    await recorder.stop();
    await recorder.start();
    recorder.cancel();
    await recorder.start();
    expect(recorder.state).toBe('recording');
    recorder.cancel();
  });

  it('reports the one-hour cap once, and keeps what it has', async () => {
    const r = rig({ sampleRate: 1000 });
    const recorder = new VoiceRecorder(r.deps);
    const onLimit = vi.fn();
    await recorder.start({ onLimit });
    r.capture.deliver(new Float32Array((VOICE_NOTE_MAX_SECONDS - 1) * 1000));
    expect(onLimit).not.toHaveBeenCalled();
    r.capture.deliver(new Float32Array(1000));
    r.capture.deliver(new Float32Array(1000));
    expect(onLimit).toHaveBeenCalledTimes(1);
    const recording = await recorder.stop();
    expect(recording.durationSeconds).toBeGreaterThanOrEqual(VOICE_NOTE_MAX_SECONDS);
  });

  it('a cancel during stop turns into a cancelled stop, not a half recording', async () => {
    const r = rig();
    let flush: (samples: Float32Array) => void = () => undefined;
    r.capture.flush = () =>
      new Promise((resolve) => {
        flush = resolve;
      });
    const recorder = new VoiceRecorder(r.deps);
    await recorder.start();
    const stopping = recorder.stop();
    expect(recorder.state).toBe('stopping');
    expect(stopped(r)).toBe(true);
    recorder.cancel();
    flush(new Float32Array(0));
    await expect(stopping).rejects.toBeInstanceOf(RecordingCancelled);
    expect(recorder.state).toBe('idle');
  });
});
