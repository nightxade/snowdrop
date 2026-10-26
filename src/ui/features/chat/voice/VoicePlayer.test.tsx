import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { TooltipProvider } from '@/ui/primitives';
import { FakeAudio } from './fakeAudio';
import { VoicePlayback } from './voicePlayback';
import { VoicePlayer, type VoicePlayerProps } from './VoicePlayer';
import { clearWaveformCache } from './waveformCache';

let audio: FakeAudio;
let playback: VoicePlayback;
beforeEach(() => {
  audio = new FakeAudio();
  playback = new VoicePlayback(() => audio);
  clearWaveformCache();
});
afterEach(cleanup);

const LEVELS = Array.from({ length: 100 }, (_, i) => (i * 7) % 256);

function renderPlayer(props: Partial<VoicePlayerProps> = {}) {
  return render(
    <TooltipProvider>
      <VoicePlayer
        playKey="m1"
        url="blob:m1"
        playback={playback}
        waveform={{ keys: ['url:blob:m1'], known: { levels: LEVELS, duration: 65 } }}
        {...props}
      />
    </TooltipProvider>,
  );
}

/** Lets the playing state settle (the fake's play() resolves on a microtask). */
const settle = () => act(() => Promise.resolve());

describe('<VoicePlayer />', () => {
  it('shows the length from the waveform, and a bar for each step', () => {
    const { container } = renderPlayer();
    expect(screen.getByText('1:05')).toBeTruthy();
    expect(container.querySelectorAll('[aria-hidden]').length).toBeGreaterThanOrEqual(47);
    expect(screen.getByRole('button', { name: 'Play voice message' })).toBeTruthy();
  });

  it('plays and pauses from the button, and counts down while playing', async () => {
    renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Play voice message' }));
    await settle();
    expect(audio.src).toBe('blob:m1');
    expect(screen.getByRole('button', { name: 'Pause voice message' })).toBeTruthy();
    act(() => {
      audio.currentTime = 5;
      audio.emit('timeupdate');
    });
    expect(screen.getByText('1:00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause voice message' }));
    expect(screen.getByRole('button', { name: 'Play voice message' })).toBeTruthy();
  });

  it('exposes the position as a slider and moves it with the keyboard (1 s and 5 s steps)', async () => {
    renderPlayer();
    const slider = screen.getByRole('slider', { name: 'Voice message position' });
    expect(slider.getAttribute('aria-valuemax')).toBe('65');
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    expect(slider.getAttribute('aria-valuetext')).toBe('0 seconds of 1 minute 5 seconds');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await settle();
    // Moving starts playback at the new place, as Signal Desktop does.
    expect(audio.plays).toBe(1);
    act(() => {
      audio.setLength(65);
    });
    expect(audio.currentTime).toBeCloseTo(1);
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(audio.currentTime).toBeCloseTo(6);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(audio.currentTime).toBeCloseTo(5);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(audio.currentTime).toBe(0);
  });

  it('seeks to where a bar is pressed, and rewinds from the very start', async () => {
    renderPlayer();
    const slider = screen.getByRole('slider', { name: 'Voice message position' });
    slider.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect;
    audio.duration = 65;
    fireEvent.pointerDown(slider, { clientX: 200, button: 0, pointerId: 1 });
    await settle();
    expect(audio.plays).toBe(1);
    act(() => {
      audio.setLength(65);
    });
    expect(audio.currentTime).toBeCloseTo(32.5);
    fireEvent.pointerMove(slider, { clientX: 250, pointerId: 1 });
    expect(audio.currentTime).toBeCloseTo(48.75);
    fireEvent.pointerUp(slider, { pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 120, pointerId: 1 });
    expect(audio.currentTime).toBeCloseTo(48.75);
    fireEvent.pointerDown(slider, { clientX: 104, button: 0, pointerId: 1 });
    expect(audio.currentTime).toBe(0);
  });

  it('cycles the speed from a button that only appears once the note is loaded', async () => {
    renderPlayer();
    expect(screen.queryByRole('button', { name: /Playback speed/u })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play voice message' }));
    await settle();
    const rate = screen.getByRole('button', { name: /Playback speed 1x/u });
    expect(rate.textContent).toBe('1×');
    fireEvent.click(rate);
    expect(screen.getByRole('button', { name: /Playback speed 1.5x/u }).textContent).toBe('1.5×');
    expect(audio.playbackRate).toBe(1.5);
    fireEvent.click(screen.getByRole('button', { name: /Playback speed 1.5x/u }));
    expect(audio.playbackRate).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: /Playback speed 2x/u }));
    expect(audio.playbackRate).toBe(0.5);
  });

  it('marks a note played when playback starts, and shows an unplayed dot until then', async () => {
    const onPlayed = vi.fn();
    const { rerender } = renderPlayer({ unplayed: true, onPlayed });
    expect(screen.getByText('Not played yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play voice message' }));
    await settle();
    expect(onPlayed).toHaveBeenCalledOnce();
    rerender(
      <TooltipProvider>
        <VoicePlayer
          playKey="m1"
          url="blob:m1"
          playback={playback}
          unplayed={false}
          waveform={{ keys: ['url:blob:m1'], known: { levels: LEVELS, duration: 65 } }}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByText('Not played yet')).toBeNull();
  });

  it('autoplays the next voice note when this one ends', async () => {
    const next = render(
      <TooltipProvider>
        <VoicePlayer
          playKey="m2"
          url="blob:m2"
          playback={playback}
          waveform={{ keys: ['url:blob:m2'], known: { levels: LEVELS, duration: 10 } }}
        />
      </TooltipProvider>,
    );
    renderPlayer({ nextKey: () => 'm2' });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Play voice message' })[1] as HTMLElement,
    );
    await settle();
    act(() => {
      audio.emit('ended');
    });
    await settle();
    expect(audio.src).toBe('blob:m2');
    expect(next.getByRole('button', { name: 'Pause voice message' })).toBeTruthy();
  });

  it('stops its sound when it leaves the page', async () => {
    const { unmount } = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Play voice message' }));
    await settle();
    expect(playback.active).not.toBeNull();
    unmount();
    expect(playback.active).toBeNull();
  });

  it('says so when the audio will not play', async () => {
    audio.nextPlay = () => Promise.reject(new Error('refused'));
    renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Play voice message' }));
    await settle();
    await settle();
    expect(screen.getByRole('status').textContent).toBe("Can't play this");
  });

  it('shows the file size until the length is known', () => {
    renderPlayer({ waveform: { keys: ['url:blob:x'] }, sizeText: '48 KB' });
    expect(screen.getByText('48 KB')).toBeTruthy();
  });

  it('has no axe violations idle, playing, or unplayed', async () => {
    const { container } = renderPlayer({ unplayed: true });
    expect((await axe(container)).violations.map((v) => v.id)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Play voice message' }));
    await settle();
    expect((await axe(container)).violations.map((v) => v.id)).toEqual([]);
  });
});
