import type { AudioLike } from './voicePlayback';

/** An audio element that does nothing but remember, for tests of the player. */
export class FakeAudio implements AudioLike {
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  playbackRate = 1;
  plays = 0;
  pauses = 0;
  /** What the next `play()` does; a rejection is how a webview refuses a file. */
  nextPlay: () => Promise<void> | undefined = () => Promise.resolve();
  private readonly listeners = new Map<string, (() => void)[]>();

  play(): Promise<void> | undefined {
    this.plays++;
    return this.nextPlay();
  }
  pause(): void {
    this.pauses++;
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  load(): void {
    // Nothing to load.
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  /** The file says how long it is. */
  setLength(seconds: number): void {
    this.duration = seconds;
    this.emit('loadedmetadata');
  }
}
