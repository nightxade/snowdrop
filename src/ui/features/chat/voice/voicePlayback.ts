/**
 * One voice note plays at a time, through one shared audio element (starting a
 * note stops the previous one). When a note ends the next voice note in the
 * conversation starts by itself, at the same speed, as Signal Desktop does.
 * Players subscribe by key and only the one that owns the audio re-renders on
 * every tick.
 */

/** The speeds, in the order the button cycles through them: Signal Desktop's. */
export const PLAYBACK_RATES = [1, 1.5, 2, 0.5] as const;

export function nextPlaybackRate(rate: number): number {
  const index = PLAYBACK_RATES.indexOf(rate as (typeof PLAYBACK_RATES)[number]);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

/** The part of `HTMLAudioElement` this needs, so tests can stand in for it. */
export interface AudioLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  playbackRate: number;
  play(): Promise<void> | undefined;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  addEventListener(type: string, listener: () => void): void;
}

export interface ActiveVoice {
  key: string;
  playing: boolean;
  /** Asked to play but not sounding yet (a webview can take a moment to open the file). */
  pending: boolean;
  /** Seconds. */
  currentTime: number;
  /** Seconds; undefined until the file says. */
  duration: number | undefined;
}

export interface PlayRequest {
  key: string;
  url: string;
  /** Where to start, 0..1 of the length (it is applied once the length is known). */
  startRatio?: number;
  /** The key of the voice note to play when this one ends; none stops. */
  nextKey?: () => string | undefined;
  /** Runs when playback of this note really starts (the "played" mark). */
  onStart?: () => void;
}

interface Loaded {
  key: string;
  nextKey: (() => string | undefined) | undefined;
}

export class VoicePlayback {
  private audio: AudioLike | null = null;
  private loaded: Loaded | null = null;
  private state: ActiveVoice | null = null;
  private failure: string | null = null;
  private pendingRatio: number | null = null;
  private speed = 1;
  /** Bumped on every play/stop, so a late `play()` rejection can't touch a newer note. */
  private token = 0;
  private readonly starters = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly makeAudio: () => AudioLike = () => new Audio()) {}

  /** The playing or paused voice note, if any. */
  get active(): ActiveVoice | null {
    return this.state;
  }

  /** The key whose audio last failed to play. */
  get failedKey(): string | null {
    return this.failure;
  }

  get rate(): number {
    return this.speed;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** What a player with `key` shows: its own state, or nothing. */
  snapshot = (key: string): ActiveVoice | null => (this.state?.key === key ? this.state : null);

  /** Lets the note with `key` be started by autoplay while it is on screen. */
  registerStarter(key: string, start: () => void): () => void {
    this.starters.set(key, start);
    return () => {
      if (this.starters.get(key) === start) this.starters.delete(key);
    };
  }

  play(request: PlayRequest): void {
    const audio = this.element();
    const token = ++this.token;
    this.failure = null;
    if (this.loaded?.key !== request.key || audio.src !== request.url) {
      audio.pause();
      audio.src = request.url;
      this.loaded = { key: request.key, nextKey: request.nextKey };
      this.state = {
        key: request.key,
        playing: false,
        pending: true,
        currentTime: 0,
        duration: undefined,
      };
      this.pendingRatio = request.startRatio ?? null;
    } else if (request.startRatio !== undefined) {
      this.seekTo(audio, request.startRatio);
    }
    audio.playbackRate = this.speed;
    if (this.state && !this.state.playing) this.state = { ...this.state, pending: true };
    this.emit();
    let started: Promise<void> | undefined;
    try {
      started = audio.play();
    } catch {
      this.fail(request.key, token);
      return;
    }
    if (started === undefined) {
      this.markPlaying(request, token);
      return;
    }
    started.then(
      () => {
        this.markPlaying(request, token);
      },
      () => {
        this.fail(request.key, token);
      },
    );
  }

  pause(): void {
    this.audio?.pause();
    this.token++;
    if (this.state?.playing || this.state?.pending) {
      this.state = { ...this.state, playing: false, pending: false };
      this.emit();
    }
  }

  /** Moves to `ratio` (0..1) of the active note. */
  seek(ratio: number): void {
    if (!this.audio || !this.state) return;
    this.seekTo(this.audio, ratio);
    this.state = { ...this.state, currentTime: this.audio.currentTime };
    this.emit();
  }

  setRate(rate: number): void {
    this.speed = rate;
    if (this.audio) this.audio.playbackRate = rate;
    this.emit();
  }

  /** Stops whatever plays and lets go of its audio. */
  stop(): void {
    this.token++;
    const audio = this.audio;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    this.loaded = null;
    this.pendingRatio = null;
    if (this.state !== null) {
      this.state = null;
      this.emit();
    }
  }

  /** A player went away: its note stops with it (nothing else is left to show or stop it). */
  release(key: string): void {
    if (this.state?.key === key) this.stop();
  }

  private markPlaying(request: PlayRequest, token: number): void {
    if (token !== this.token || this.state?.key !== request.key) return;
    this.state = { ...this.state, playing: true, pending: false };
    request.onStart?.();
    this.emit();
  }

  private fail(key: string, token: number): void {
    if (token !== this.token) return;
    this.stop();
    this.failure = key;
    this.emit();
  }

  private seekTo(audio: AudioLike, ratio: number): void {
    const duration = Number.isFinite(audio.duration) ? audio.duration : undefined;
    if (duration === undefined || duration <= 0) {
      this.pendingRatio = Math.min(1, Math.max(0, ratio));
      return;
    }
    audio.currentTime = Math.min(1, Math.max(0, ratio)) * duration;
  }

  private element(): AudioLike {
    if (this.audio) return this.audio;
    const audio = this.makeAudio();
    this.audio = audio;
    audio.addEventListener('timeupdate', () => {
      if (!this.state) return;
      this.state = { ...this.state, currentTime: audio.currentTime };
      this.emit();
    });
    const onLength = () => {
      if (!this.state) return;
      const duration =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined;
      if (duration !== undefined && this.pendingRatio !== null) {
        audio.currentTime = this.pendingRatio * duration;
        this.pendingRatio = null;
      }
      this.state = { ...this.state, duration, currentTime: audio.currentTime };
      this.emit();
    };
    audio.addEventListener('loadedmetadata', onLength);
    audio.addEventListener('durationchange', onLength);
    audio.addEventListener('pause', () => {
      // Paused by the system (or the end): keep the display honest.
      if (this.state?.playing) {
        this.state = { ...this.state, playing: false, pending: false };
        this.emit();
      }
    });
    audio.addEventListener('playing', () => {
      if (this.state && !this.state.playing) {
        this.state = { ...this.state, playing: true, pending: false };
        this.emit();
      }
    });
    audio.addEventListener('error', () => {
      const key = this.state?.key;
      if (key !== undefined) this.fail(key, this.token);
    });
    audio.addEventListener('ended', () => {
      this.onEnded();
    });
    return audio;
  }

  private onEnded(): void {
    const nextKey = this.loaded?.nextKey?.();
    const start = nextKey !== undefined ? this.starters.get(nextKey) : undefined;
    this.stop();
    start?.();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The app's one playback. */
export const voicePlayback = new VoicePlayback();
