import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { FakeAudio } from './fakeAudio';
import { MiniPlayer } from './MiniPlayer';
import { VoicePlayback } from './voicePlayback';

let audio: FakeAudio;
let playback: VoicePlayback;
let stores: ReturnType<typeof createStores>;
beforeEach(() => {
  audio = new FakeAudio();
  playback = new VoicePlayback(() => audio);
  stores = createStores();
  stores.session.setState({ self: { id: 'me', name: 'Me' } } as never);
  stores.contacts.setState({ byId: { ana: { id: 'ana', name: 'Ana Reyes' } } } as never);
});
afterEach(cleanup);

const settle = () => act(() => Promise.resolve());

function show() {
  return render(
    <SnowdropContextProvider
      value={
        { stores, repository: { get: () => Promise.resolve(undefined) } } as unknown as AppServices
      }
    >
      <MiniPlayer playback={playback} />
    </SnowdropContextProvider>,
  );
}

const start = async (authorId = 'ana') => {
  act(() => {
    playback.play({
      key: 'k',
      url: 'blob:k',
      source: { conversationId: 'c1', messageId: 'm1', authorId },
    });
  });
  await settle();
};

describe('<MiniPlayer />', () => {
  it('is absent while nothing plays', () => {
    show();
    expect(screen.queryByRole('group', { name: 'Voice message playing' })).toBeNull();
  });

  it("shows who the note is from and how far along it is, 'You' for your own", async () => {
    show();
    await start();
    expect(screen.getByText('Ana Reyes')).toBeTruthy();
    expect(screen.getByText('0:00')).toBeTruthy();
    act(() => {
      audio.currentTime = 65;
      audio.emit('timeupdate');
    });
    expect(screen.getByText('1:05')).toBeTruthy();
    act(() => {
      playback.stop();
    });
    await start('me');
    expect(screen.getByText('You')).toBeTruthy();
  });

  it('pauses and resumes from where it was, and cycles the speed', async () => {
    show();
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Pause voice message' }));
    expect(screen.getByRole('button', { name: 'Play voice message' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Playback speed/u })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play voice message' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Pause voice message' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Playback speed 1x/u }));
    expect(audio.playbackRate).toBe(1.5);
    expect(screen.getByRole('button', { name: /Playback speed 1.5x/u }).textContent).toBe('1.5×');
  });

  it('closes by stopping the note, and goes away', async () => {
    show();
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Close voice message player' }));
    expect(playback.active).toBeNull();
    expect(screen.queryByRole('group', { name: 'Voice message playing' })).toBeNull();
  });

  it('stops with the app (a lock or restart tears the shell down)', async () => {
    const view = show();
    await start();
    view.unmount();
    expect(playback.active).toBeNull();
  });

  it('has labelled, focusable controls and no axe violations', async () => {
    const { container } = show();
    await start();
    for (const b of screen.getAllByRole('button')) {
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b.tabIndex).toBe(0);
    }
    expect((await axe(container)).violations.map((v) => v.id)).toEqual([]);
  });
});
