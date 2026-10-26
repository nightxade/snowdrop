/**
 * Records one voice note: microphone → samples → MP3, the same format Signal
 * Desktop sends, so every phone plays it. The pieces that touch the browser
 * (the microphone, the audio graph, the encoder) are injected, which keeps the
 * state machine, and above all the promise that the microphone is released,
 * testable without any of them.
 */
import { VOICE_NOTE_MAX_SECONDS } from '@/core/domain';
import { meanSquare, toLevel, WaveformBuilder } from './waveform';

export type VoiceErrorKind =
  /** The system or the app said no to the microphone. */
  | 'denied'
  /** There is no microphone to record from. */
  | 'no-device'
  /** This webview can't record at all. */
  | 'unsupported'
  | 'failed';

export class VoiceRecorderError extends Error {
  readonly kind: VoiceErrorKind;
  constructor(kind: VoiceErrorKind) {
    super(voiceErrorMessage(kind));
    this.name = 'VoiceRecorderError';
    this.kind = kind;
  }
}

export function voiceErrorMessage(kind: VoiceErrorKind): string {
  switch (kind) {
    case 'denied':
      return "Snowdrop can't use the microphone. Allow it in your system's sound or privacy settings, then try again.";
    case 'no-device':
      return 'No microphone found. Connect one and try again.';
    case 'unsupported':
      return "Voice messages can't be recorded here.";
    case 'failed':
      return 'The voice recorder stopped working. Try again.';
  }
}

/** A name from `DOMException`, whatever realm it came from. */
function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

export function classifyMicrophoneError(error: unknown): VoiceErrorKind {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-device';
    default:
      return 'failed';
  }
}

export interface Mp3Encoder {
  /** MP3 bytes for these samples (possibly none yet); a copy the caller owns. */
  encode(samples: Float32Array): Uint8Array;
  /** The remaining frames; the encoder is finished after this. */
  finish(): Uint8Array;
}

/** The audio graph reading the microphone. */
export interface CaptureSession {
  /** Known as soon as the graph exists, before the microphone is attached. */
  readonly sampleRate: number;
  /** Connects the microphone and gets the graph ready; resolves when samples can flow. */
  attach(stream: MediaStream): Promise<void>;
  /** Starts delivering blocks of samples. */
  start(onBlock: (samples: Float32Array) => void): void;
  /** The samples captured since the last block (they have not been delivered). */
  flush(): Promise<Float32Array>;
  /** Tears the graph down, whether or not it was ever attached. Safe to call twice. */
  close(): void;
}

export interface RecorderDeps {
  /** `getUserMedia({ audio })`: the microphone permission is asked for here. */
  openStream(): Promise<MediaStream>;
  /**
   * Builds the audio graph. Called synchronously from `start()`, while the
   * click or key press that started the recording is still "current": the
   * webview only lets an audio context run when one is created then.
   */
  createCapture(): CaptureSession;
  createEncoder(sampleRate: number): Promise<Mp3Encoder>;
}

export interface VoiceRecording {
  blob: Blob;
  durationSeconds: number;
  /** Loudness levels, 0..255 each (see `waveform.ts`). */
  waveform: number[];
}

export interface StartOptions {
  /** The loudness of each block as it is recorded, 0..255. */
  onLevel?: (level: number) => void;
  /** The recording reached the one-hour cap; it keeps what it has until `stop()`. */
  onLimit?: () => void;
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

/** Thrown out of `start()` when `cancel()` got there first. */
export class RecordingCancelled extends Error {
  constructor() {
    super('Recording cancelled');
    this.name = 'RecordingCancelled';
  }
}

interface Session {
  /** Null until the microphone has been handed over. */
  stream: MediaStream | null;
  capture: CaptureSession;
}

export class VoiceRecorder {
  private current: RecorderState = 'idle';
  /** Bumped by every `cancel()`, so an async `start()` can tell it was overtaken. */
  private generation = 0;
  private session: Session | null = null;
  private encoder: Mp3Encoder | null = null;
  private parts: Uint8Array[] = [];
  private waveform = new WaveformBuilder();
  private samples = 0;
  private sampleRate = 0;
  private limitReached = false;
  private options: StartOptions = {};

  constructor(private readonly deps: RecorderDeps) {}

  get state(): RecorderState {
    return this.current;
  }

  /** Opens the microphone and starts recording. Rejects with `VoiceRecorderError` or `RecordingCancelled`. */
  async start(options: StartOptions = {}): Promise<void> {
    if (this.current !== 'idle') throw new VoiceRecorderError('failed');
    this.current = 'starting';
    this.options = options;
    this.parts = [];
    this.waveform = new WaveformBuilder();
    this.samples = 0;
    this.limitReached = false;
    const generation = ++this.generation;
    const overtaken = () => generation !== this.generation;

    let session: Session;
    let encoderReady: Promise<Mp3Encoder>;
    try {
      session = { stream: null, capture: this.deps.createCapture() };
      this.session = session;
      // Loads while the permission is being asked for.
      encoderReady = this.deps.createEncoder(session.capture.sampleRate);
      encoderReady.catch(() => undefined);
    } catch {
      this.release();
      throw new VoiceRecorderError('failed');
    }

    try {
      let stream: MediaStream;
      try {
        stream = await this.deps.openStream();
      } catch (error) {
        if (overtaken()) throw new RecordingCancelled();
        throw new VoiceRecorderError(classifyMicrophoneError(error));
      }
      if (overtaken()) {
        // cancel() ran while the microphone was opening: it had nothing to release yet.
        releaseStream(stream);
        throw new RecordingCancelled();
      }
      session.stream = stream;
      await session.capture.attach(stream);
      if (overtaken()) throw new RecordingCancelled();
      this.sampleRate = session.capture.sampleRate;
      this.encoder = await encoderReady;
      if (overtaken()) throw new RecordingCancelled();
      session.capture.start((block) => {
        this.take(block);
      });
      this.current = 'recording';
    } catch (error) {
      // A cancelled start has been released by `cancel()`; anything else is released here.
      if (!overtaken()) this.release();
      else this.releaseSession(session);
      if (error instanceof RecordingCancelled || error instanceof VoiceRecorderError) throw error;
      throw new VoiceRecorderError('failed');
    }
  }

  /** Stops, releases the microphone at once, and returns what was recorded. */
  async stop(): Promise<VoiceRecording> {
    const session = this.session;
    const encoder = this.encoder;
    if (this.current !== 'recording' || !session?.stream || !encoder)
      throw new VoiceRecorderError('failed');
    const generation = this.generation;
    this.current = 'stopping';
    // The microphone goes first; the samples still buffered in the graph are read after.
    releaseStream(session.stream);
    try {
      const rest = await session.capture.flush();
      if (generation !== this.generation) throw new RecordingCancelled();
      if (rest.length > 0) this.take(rest);
      const tail = encoder.finish();
      if (tail.length > 0) this.parts.push(tail);
    } catch (error) {
      if (generation === this.generation) this.release();
      if (error instanceof RecordingCancelled) throw error;
      throw new VoiceRecorderError('failed');
    }
    this.releaseSession(session);
    const recording: VoiceRecording = {
      blob: new Blob(this.parts as BlobPart[], { type: 'audio/mpeg' }),
      durationSeconds: this.sampleRate > 0 ? this.samples / this.sampleRate : 0,
      waveform: this.waveform.collect(),
    };
    this.reset();
    return recording;
  }

  /** Throws the recording away and releases the microphone, whatever state it is in. */
  cancel(): void {
    this.generation++;
    this.release();
  }

  private take(block: Float32Array): void {
    if (this.current !== 'recording' && this.current !== 'stopping') return;
    const bytes = this.encoder?.encode(block);
    if (bytes && bytes.length > 0) this.parts.push(bytes);
    this.waveform.push(block);
    this.samples += block.length;
    this.options.onLevel?.(toLevel(meanSquare(block)));
    if (
      !this.limitReached &&
      this.sampleRate > 0 &&
      this.samples / this.sampleRate >= VOICE_NOTE_MAX_SECONDS
    ) {
      this.limitReached = true;
      this.options.onLimit?.();
    }
  }

  private release(): void {
    const session = this.session;
    if (session) this.releaseSession(session);
    this.reset();
  }

  private releaseSession(session: Session): void {
    if (session.stream) releaseStream(session.stream);
    session.capture.close();
    if (this.session === session) this.session = null;
  }

  private reset(): void {
    this.session = null;
    this.encoder = null;
    this.parts = [];
    this.current = 'idle';
  }
}

/** Stops every track: this is what turns the microphone (and its system indicator) off. */
export function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
