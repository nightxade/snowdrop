import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ConversationId, type Message } from '@/core/domain';
import { applyDelete } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { FakeAudio } from './fakeAudio';
import { messageGone, usePlaybackGuard } from './playbackGuard';
import { VoicePlayback } from './voicePlayback';

afterEach(cleanup);

const cid = 'c1' as ConversationId;
const msg = (seq: number): Message => makeMessage({ sentAt: seq, seq, authorId: 'ana' });
const win = (anchored: boolean, ...messages: Message[]) => ({
  ids: messages.map((m) => m.id),
  byId: Object.fromEntries(messages.map((m) => [m.id, m])),
  anchoredToPresent: anchored,
});

describe('messageGone', () => {
  it('is true for a message marked deleted', () => {
    const a = msg(1);
    expect(messageGone(win(true, a), win(true, applyDelete(a)), a.id)).toBe(true);
  });

  it('is true when it vanished from inside the window, or from the newest end of one at the present', () => {
    const [a, b, c] = [msg(1), msg(2), msg(3)] as [Message, Message, Message];
    expect(messageGone(win(false, a, b, c), win(false, a, c), b.id)).toBe(true);
    expect(messageGone(win(true, a, b), win(true, a), b.id)).toBe(true);
  });

  it('is false when it merely left the window by eviction', () => {
    const [a, b, c] = [msg(1), msg(2), msg(3)] as [Message, Message, Message];
    // Oldest end evicted.
    expect(messageGone(win(true, a, b, c), win(true, b, c), a.id)).toBe(false);
    // Newest end evicted from a window that no longer reaches the present.
    expect(messageGone(win(true, a, b, c), win(false, a, b), c.id)).toBe(false);
    // Never in it.
    expect(messageGone(win(true, a), win(true, a, b), c.id)).toBe(false);
  });
});

describe('usePlaybackGuard', () => {
  function setup(
    stored: (id: string) => Promise<Message | undefined> = () => Promise.resolve(msg(1)),
  ) {
    const audio = new FakeAudio();
    const playback = new VoicePlayback(() => audio);
    const stores = createStores();
    stores.session.setState({ self: { id: 'me', name: 'Me' } } as never);
    const a = msg(1);
    const b = msg(2);
    stores.messages
      .getState()
      .replaceWindow(cid, [a, b], { hasMoreBefore: false, hasMoreAfter: false });
    function Host() {
      usePlaybackGuard(playback);
      return null;
    }
    const view = render(
      <SnowdropContextProvider
        value={{ stores, repository: { get: stored } } as unknown as AppServices}
      >
        <Host />
      </SnowdropContextProvider>,
    );
    const play = async () => {
      playback.play({
        key: 'k',
        url: 'blob:k',
        source: { conversationId: cid, messageId: a.id, authorId: 'ana' },
      });
      await act(() => Promise.resolve());
    };
    return { playback, stores, a, b, view, play };
  }

  it('stops when the playing message is deleted for everyone or expires, not for another', async () => {
    const { playback, stores, a, b, play } = setup();
    await play();
    act(() => {
      stores.messages.getState().update(cid, b.id, (m) => applyDelete(m));
    });
    expect(playback.active).not.toBeNull();
    act(() => {
      stores.messages.getState().update(cid, a.id, (m) => applyDelete(m));
    });
    expect(playback.active).toBeNull();
  });

  it('keeps playing when the message only scrolls out of the window (storage still has it)', async () => {
    const get = vi.fn((_id: string) => Promise.resolve(msg(1)));
    const { playback, stores, b, play } = setup(get);
    await play();
    act(() => {
      stores.messages
        .getState()
        .replaceWindow(cid, [b], { hasMoreBefore: true, hasMoreAfter: false });
    });
    await act(() => Promise.resolve());
    expect(get).toHaveBeenCalledOnce();
    expect(playback.active).not.toBeNull();
  });

  it('stops when the oldest message expires, which looks like eviction but storage no longer has it', async () => {
    const { playback, stores, a, play } = setup(() => Promise.resolve(undefined));
    await play();
    act(() => {
      stores.messages.getState().remove(cid, a.id);
    });
    await act(() => Promise.resolve());
    expect(playback.active).toBeNull();
  });

  it('stops on sign-out and when the host goes away', async () => {
    const { playback, stores, view, play } = setup();
    await play();
    act(() => {
      stores.ui.getState().setSigningOut(true);
    });
    expect(playback.active).toBeNull();
    await play();
    act(() => {
      stores.session.setState({ self: null } as never);
    });
    expect(playback.active).toBeNull();
    await play();
    view.unmount();
    expect(playback.active).toBeNull();
  });
});
