import { describe, expect, it, vi } from 'vitest';
import { FakeAudio } from './fakeAudio';
import { nextPlaybackRate, PLAYBACK_RATES, VoicePlayback } from './voicePlayback';

function setup() {
  const audio = new FakeAudio();
  const playback = new VoicePlayback(() => audio);
  return { audio, playback };
}

describe('VoicePlayback mini-player support', () => {
  const source = { conversationId: 'c', messageId: 'm', authorId: 'ana' };

  it('says where the playing note comes from, also for one started by autoplay', async () => {
    const { audio, playback } = setup();
    playback.play({
      key: 'a',
      url: 'blob:a',
      source,
      next: () => ({
        key: 'b',
        source: { ...source, messageId: 'm2' },
        resolveUrl: () => Promise.resolve('blob:b'),
      }),
    });
    await Promise.resolve();
    expect(playback.active?.source).toEqual(source);
    audio.emit('ended');
    await vi.waitFor(() => {
      expect(playback.active).toMatchObject({ key: 'b', playing: true });
    });
    expect(playback.active?.source?.messageId).toBe('m2');
  });

  it('resumes a paused note from where it stopped', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a', source });
    await Promise.resolve();
    audio.currentTime = 12;
    playback.pause();
    expect(playback.active).toMatchObject({ playing: false, pending: false });
    const plays = audio.plays;
    playback.resume();
    expect(playback.active).toMatchObject({ pending: true });
    await Promise.resolve();
    expect(playback.active).toMatchObject({ playing: true, pending: false });
    expect(audio.plays).toBe(plays + 1);
    expect(audio.currentTime).toBe(12);
    // Nothing to resume when idle or already playing.
    playback.resume();
    expect(audio.plays).toBe(plays + 1);
    playback.stop();
    playback.resume();
    expect(audio.plays).toBe(plays + 1);
  });

  it('says so when a resume is refused', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    playback.pause();
    audio.nextPlay = () => Promise.reject(new Error('no'));
    playback.resume();
    await vi.waitFor(() => {
      expect(playback.failedKey).toBe('a');
    });
  });

  it('starts the next note when its lookup has to read storage', async () => {
    const { audio, playback } = setup();
    playback.play({
      key: 'a',
      url: 'blob:a',
      next: () => Promise.resolve({ key: 'b', resolveUrl: () => Promise.resolve('blob:b') }),
    });
    await Promise.resolve();
    audio.emit('ended');
    await vi.waitFor(() => {
      expect(audio.src).toBe('blob:b');
    });
  });

  it('does not start a looked-up next note after the player was closed meanwhile', async () => {
    const { audio, playback } = setup();
    let found: (t: { key: string; resolveUrl: () => Promise<string> }) => void = () => undefined;
    playback.play({
      key: 'a',
      url: 'blob:a',
      next: () =>
        new Promise((resolve) => {
          found = resolve;
        }),
    });
    await Promise.resolve();
    audio.emit('ended');
    playback.play({ key: 'x', url: 'blob:x' });
    found({ key: 'b', resolveUrl: () => Promise.resolve('blob:b') });
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.src).toBe('blob:x');
  });
});

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

  it('starts the next voice note when one ends, with no player on screen for it', async () => {
    const { audio, playback } = setup();
    const onStart = vi.fn();
    playback.play({
      key: 'a',
      url: 'blob:a',
      next: () => ({
        key: 'b',
        resolveUrl: () => Promise.resolve('blob:b'),
        onStart,
      }),
    });
    await Promise.resolve();
    audio.emit('ended');
    // Looking for the file: the note is already shown as starting.
    expect(playback.snapshot('b')).toMatchObject({ pending: true });
    await vi.waitFor(() => {
      expect(playback.snapshot('b')).toMatchObject({ playing: true });
    });
    expect(audio.src).toBe('blob:b');
    expect(onStart).toHaveBeenCalledOnce();
    expect(playback.snapshot('a')).toBeNull();
  });

  it('chains through several notes', async () => {
    const { audio, playback } = setup();
    const c = { key: 'c', resolveUrl: () => Promise.resolve('blob:c') };
    const b = { key: 'b', resolveUrl: () => Promise.resolve('blob:b'), next: () => c };
    playback.play({ key: 'a', url: 'blob:a', next: () => b });
    await Promise.resolve();
    audio.emit('ended');
    await vi.waitFor(() => {
      expect(audio.src).toBe('blob:b');
    });
    await Promise.resolve();
    audio.emit('ended');
    await vi.waitFor(() => {
      expect(audio.src).toBe('blob:c');
    });
  });

  it('stops at the end when there is no next note', async () => {
    const { audio, playback } = setup();
    playback.play({ key: 'a', url: 'blob:a', next: () => undefined });
    await Promise.resolve();
    audio.emit('ended');
    expect(playback.active).toBeNull();
    expect(audio.src).toBe('');
    playback.play({ key: 'a', url: 'blob:a' });
    await Promise.resolve();
    audio.emit('ended');
    expect(playback.active).toBeNull();
  });

  it('does not start the next note if something else was started while it was being found', async () => {
    const { audio, playback } = setup();
    let found: (url: string) => void = () => undefined;
    playback.play({
      key: 'a',
      url: 'blob:a',
      next: () => ({
        key: 'b',
        resolveUrl: () =>
          new Promise<string>((resolve) => {
            found = resolve;
          }),
      }),
    });
    await Promise.resolve();
    audio.emit('ended');
    playback.play({ key: 'x', url: 'blob:x' });
    found('blob:b');
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.src).toBe('blob:x');
  });

  it('says so when the next note cannot be found', async () => {
    const { audio, playback } = setup();
    playback.play({
      key: 'a',
      url: 'blob:a',
      next: () => ({ key: 'b', resolveUrl: () => Promise.reject(new Error('gone')) }),
    });
    await Promise.resolve();
    audio.emit('ended');
    await vi.waitFor(() => {
      expect(playback.failedKey).toBe('b');
    });
    expect(playback.active).toBeNull();
  });

  it('keeps the audio held while it plays, and lets go when it stops or changes', async () => {
    const { playback } = setup();
    const release = vi.fn();
    const retain = vi.fn(() => release);
    playback.play({ key: 'a', url: 'blob:a', retain });
    await Promise.resolve();
    expect(retain).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    playback.stop();
    expect(release).toHaveBeenCalledOnce();
    const release2 = vi.fn();
    playback.play({ key: 'a', url: 'blob:a', retain: () => release2 });
    playback.play({ key: 'b', url: 'blob:b' });
    expect(release2).toHaveBeenCalledOnce();
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
