import { describe, expect, it, vi } from 'vitest';
import { FakeAudio } from './fakeAudio';
import { nextPlaybackRate, PLAYBACK_RATES, VoicePlayback } from './voicePlayback';

function setup() {
  const audio = new FakeAudio();
  const playback = new VoicePlayback(() => audio);
  return { audio, playback };
}

describe('VoicePlayback', () => {
  it('plays a note, reports it as playing, and tells the player when it started', async () => {
    const { audio, playback } = setup();
    const onStart = vi.fn();
    playback.play({ key: 'a', url: 'blob:a', onStart });
    expect(audio.src).toBe('blob:a');
    // Asked for, not sounding yet.
    expect(playback.snapshot('a')).toMatchObject({ playing: false, pending: true });
    await Promise.resolve();
    expect(playback.snapshot('a')).toMatchObject({ playing: true, pending: false, currentTime: 0 });
    expect(playback.snapshot('b')).toBeNull();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('plays one note at a time: starting another stops the first', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    playback.play({ key: 'b', url: 'blob:b' });
    await Promise.resolve();
    expect(playback.snapshot('a')).toBeNull();
    expect(playback.snapshot('b')).toMatchObject({ playing: true });
    expect(audio.src).toBe('blob:b');
  });

  it('pauses and resumes in place, without reloading', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    audio.currentTime = 4;
    audio.emit('timeupdate');
    playback.pause();
    expect(playback.snapshot('a')).toMatchObject({
      playing: false,
      pending: false,
      currentTime: 4,
    });
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    expect(audio.currentTime).toBe(4);
    expect(playback.snapshot('a')).toMatchObject({ playing: true });
  });

  it('learns the length from the file, and applies a start position once it knows', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a', startRatio: 0.5 });
    await Promise.resolve();
    expect(audio.currentTime).toBe(0);
    audio.setLength(20);
    expect(audio.currentTime).toBe(10);
    expect(playback.snapshot('a')?.duration).toBe(20);
  });

  it('seeks within the note, clamped', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a' });
    audio.setLength(10);
    await Promise.resolve();
    playback.seek(0.3);
    expect(audio.currentTime).toBeCloseTo(3);
    playback.seek(7);
    expect(audio.currentTime).toBe(10);
    playback.seek(-1);
    expect(audio.currentTime).toBe(0);
  });

  it('cycles the speeds Signal Desktop offers and applies them, to later notes too', async () => {
    expect(PLAYBACK_RATES).toEqual([1, 1.5, 2, 0.5]);
    expect([1, 1.5, 2, 0.5].map(nextPlaybackRate)).toEqual([1.5, 2, 0.5, 1]);
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    playback.setRate(2);
    expect(audio.playbackRate).toBe(2);
    playback.play({ key: 'b', url: 'blob:b' });
    expect(audio.playbackRate).toBe(2);
  });

  it('starts the next voice note when one ends, if its player is on screen', async () => {
    const { audio, playback } = setup();
    const startB = vi.fn(() => {
      playback.play({ key: 'b', url: 'blob:b' });
    });
    playback.registerStarter('b', startB);
    playback.play({ key: 'a', url: 'blob:a', nextKey: () => 'b' });
    await Promise.resolve();
    audio.emit('ended');
    expect(startB).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(playback.snapshot('b')).toMatchObject({ playing: true });
    expect(playback.snapshot('a')).toBeNull();
  });

  it('stops at the end when there is no next note, or its player is gone', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a', nextKey: () => 'gone' });
    await Promise.resolve();
    audio.emit('ended');
    expect(playback.active).toBeNull();
    expect(audio.src).toBe('');
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    audio.emit('ended');
    expect(playback.active).toBeNull();
  });

  it('does not autoplay from a note that has no next (a draft)', async () => {
    const { audio, playback } = setup();
    const start = vi.fn();
    playback.registerStarter('b', start);
    playback.play({ key: 'draft', url: 'blob:d' });
    await Promise.resolve();
    audio.emit('ended');
    expect(start).not.toHaveBeenCalled();
  });

  it('stops with the player that went away, but not for another note', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    playback.release('b');
    expect(playback.active).not.toBeNull();
    playback.release('a');
    expect(playback.active).toBeNull();
    expect(audio.src).toBe('');
  });

  it('pausing while the file is still opening cancels the start', async () => {
    const { audio, playback } = setup();
    let begin: () => void = () => undefined;
    audio.nextPlay = () =>
      new Promise((resolve) => {
        begin = resolve;
      });
    const onStart = vi.fn();
    playback.play({ key: 'a', url: 'blob:a', onStart });
    expect(playback.snapshot('a')).toMatchObject({ pending: true, playing: false });
    playback.pause();
    begin();
    await Promise.resolve();
    expect(playback.snapshot('a')).toMatchObject({ pending: false, playing: false });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('reports a file the webview refuses to play, and clears it on the next try', async () => {
    const { audio, playback } = setup();
    audio.nextPlay = () => Promise.reject(new Error('NotSupportedError'));
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    await Promise.resolve();
    expect(playback.failedKey).toBe('a');
    expect(playback.active).toBeNull();
    audio.nextPlay = () => Promise.resolve();
    playback.play({ key: 'a', url: 'blob:a' });
    expect(playback.failedKey).toBeNull();
  });

  it('a refusal that arrives after another note started does not stop that note', async () => {
    const { audio, playback } = setup();
    let refuse: (reason: Error) => void = () => undefined;
    audio.nextPlay = () =>
      new Promise((_, reject) => {
        refuse = reject;
      });
    playback.play({ key: 'a', url: 'blob:a' });
    audio.nextPlay = () => Promise.resolve();
    playback.play({ key: 'b', url: 'blob:b' });
    refuse(new Error('late'));
    await Promise.resolve();
    await Promise.resolve();
    expect(playback.snapshot('b')).toMatchObject({ playing: true });
    expect(playback.failedKey).toBeNull();
  });

  it('keeps the display honest when the system pauses playback', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    audio.emit('pause');
    expect(playback.snapshot('a')).toMatchObject({ playing: false });
    audio.emit('playing');
    expect(playback.snapshot('a')).toMatchObject({ playing: true });
  });

  it('notifies subscribers, and only while subscribed', () => {
    const { playback } = setup();
    const listener = vi.fn();
    const off = playback.subscribe(listener);
    playback.play({ key: 'a', url: 'blob:a' });
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    playback.stop();
    expect(listener).not.toHaveBeenCalled();
  });
});
