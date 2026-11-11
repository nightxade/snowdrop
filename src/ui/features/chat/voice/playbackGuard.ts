import { ignored } from '@/core/lib';
import { useEffect } from 'react';
import type { Message, MessageId } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { voicePlayback as sharedPlayback, type VoicePlayback } from './voicePlayback';

/** A conversation window as far as this reads it. */
interface Window {
  ids: readonly MessageId[];
  byId: Readonly<Record<MessageId, Message | undefined>>;
  anchoredToPresent: boolean;
}

/**
 * Whether `id` was deleted or expired between two versions of a window, as
 * opposed to merely scrolled out of it (windows evict from their far end). It is
 * gone when the message is marked deleted; or when it was in the window before
 * and isn't now, and its place is inside the window (a window is a contiguous
 * slice), or past the newest end of one that reaches the present.
 */
export function messageGone(before: Window | undefined, after: Window, id: MessageId): boolean {
  if (after.byId[id]?.deleted === true) return true;
  const previous = before?.byId[id];
  if (!previous || after.byId[id] || previous.seq === undefined) return false;
  const first = after.ids[0] === undefined ? undefined : after.byId[after.ids[0]];
  const lastId = after.ids.at(-1);
  const last = lastId === undefined ? undefined : after.byId[lastId];
  if (first?.seq === undefined || last?.seq === undefined) return false;
  return previous.seq >= first.seq && (previous.seq <= last.seq || after.anchoredToPresent);
}

/**
 * What ends a voice note besides its own end, the stop button and another
 * note: its message being deleted or expiring, signing out, and the app going
 * away (a lock or a restart). Mounted once, by the chat column, which is there
 * whichever conversation is open.
 */
export function usePlaybackGuard(playback: VoicePlayback = sharedPlayback): void {
  const { stores, repository } = useSnowdrop();
  useEffect(() => {
    const unsubscribeMessages = stores.messages.subscribe((state, previous) => {
      const playing = playback.active;
      const source = playing?.source;
      if (!playing || !source) return;
      const window = state.windows[source.conversationId as keyof typeof state.windows];
      const before = previous.windows[source.conversationId as keyof typeof state.windows];
      if (!window || window === before) return;
      const id = source.messageId as MessageId;
      if (messageGone(before, window, id)) {
        playback.stop();
      } else if (before?.byId[id] && !window.byId[id]) {
        // Out of the window with nothing to tell removal from eviction (the oldest end
        // is where both happen): storage knows.
        const key = playing.key;
        void repository
          .get(id)
          .then((stored) => {
            if ((!stored || stored.deleted === true) && playback.active?.key === key) {
              playback.stop();
            }
          })
          .catch(ignored('storage could not say; the player keeps playing'));
      }
    });
    const unsubscribeUi = stores.ui.subscribe((state, previous) => {
      if (state.signingOut && !previous.signingOut) playback.stop();
    });
    const unsubscribeSession = stores.session.subscribe((state, previous) => {
      if (previous.self && !state.self) playback.stop();
    });
    return () => {
      unsubscribeMessages();
      unsubscribeUi();
      unsubscribeSession();
      playback.stop();
    };
  }, [stores, repository, playback]);
}
