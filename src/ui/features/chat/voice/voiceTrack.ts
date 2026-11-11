import type { ChatBackend } from '@/core/backend';
import type { Attachment, ConversationId, MessageId } from '@/core/domain';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';
import type { Message } from '@/core/domain';
import { nextVoiceNote, voicePlayKey } from './nextVoice';
import type { VoiceTrack } from './voicePlayback';

/** What a track needs from the app. */
export interface TrackDeps {
  stores: Stores;
  backend: Pick<
    ChatBackend,
    'capabilities' | 'resolveAttachmentUrl' | 'retainAttachmentUrl' | 'releaseAttachmentUrl'
  >;
  selfId: string | null | undefined;
  /** Where to look for the next note when the loaded window can't say (it is read, not paged in). */
  repository?: Pick<MessageRepository, 'get' | 'page'> | undefined;
}

/** Messages read per step while looking for the next voice note in storage. */
const LOOKUP_PAGE = 50;
/** Steps at most (50 x 10 messages): a conversation with no voice note for that long just stops. */
const LOOKUP_STEPS = 10;

/** The key under which "played" is remembered for someone's note. */
export const playedKeyOf = (authorId: string, sentAt: number): string =>
  `${authorId}\u0000${sentAt}`;

/**
 * The voice note in `messageId` as something the shared player can start with
 * no row on screen: it finds the audio itself, marks it played, and knows how
 * to find the note after it in the loaded conversation.
 */
export function voiceTrackOf(
  deps: TrackDeps,
  conversationId: ConversationId,
  messageId: MessageId,
  authorId: string,
  sentAt: number,
  attachment: Attachment,
): VoiceTrack {
  const { stores, backend } = deps;
  const direct = attachment.url;
  const canResolve = backend.capabilities.features.has('attachmentUrls');
  return {
    key: voicePlayKey(messageId, attachment.id),
    resolveUrl: () => {
      if (direct !== undefined) return Promise.resolve(direct);
      if (!canResolve) return Promise.reject(new Error('No audio'));
      return backend.resolveAttachmentUrl(conversationId, attachment);
    },
    onStart: () => {
      if (authorId !== deps.selfId) {
        stores.local.getState().markVoiceNotePlayed(playedKeyOf(authorId, sentAt));
      }
    },
    ...(direct === undefined && canResolve
      ? {
          retain: () => {
            backend.retainAttachmentUrl(attachment);
            return () => {
              backend.releaseAttachmentUrl(attachment);
            };
          },
        }
      : {}),
    source: { conversationId, messageId, authorId },
    next: () => {
      const make = (m: { message: Message; attachment: Attachment }): VoiceTrack =>
        voiceTrackOf(
          deps,
          conversationId,
          m.message.id,
          m.message.authorId,
          m.message.sentAt,
          m.attachment,
        );
      const window = stores.messages.getState().windows[conversationId];
      const inWindow = window?.byId[messageId] !== undefined;
      const found =
        window && inWindow ? nextVoiceNote(window.ids, window.byId, messageId) : undefined;
      if (found) return make(found);
      // Nothing after it in a window that reaches the present: it was the last.
      if (window && inWindow && window.anchoredToPresent) return undefined;
      // Scrolled far enough that it left the window, or the next one isn't loaded: ask storage.
      return findInStorage(deps.repository, conversationId, messageId).then(
        (next) => next && make(next),
      );
    },
  };
}

/** The first voice note after `messageId` in stored history, if there is one within reach. */
async function findInStorage(
  repository: TrackDeps['repository'],
  conversationId: ConversationId,
  messageId: MessageId,
): Promise<{ message: Message; attachment: Attachment } | undefined> {
  if (!repository) return undefined;
  const current = await repository.get(messageId);
  if (current?.seq === undefined) return undefined;
  let after = current.seq;
  for (let step = 0; step < LOOKUP_STEPS; step++) {
    const page = await repository.page(conversationId, { after, limit: LOOKUP_PAGE });
    const byId = Object.fromEntries(page.map((m) => [m.id, m]));
    // `current` leads so the helper starts right after it.
    const found = nextVoiceNote(
      [current.id, ...page.map((m) => m.id)],
      { ...byId, [current.id]: current },
      current.id,
    );
    if (found) return found;
    const last = page.at(-1)?.seq;
    if (page.length < LOOKUP_PAGE || last === undefined) return undefined;
    after = last;
  }
  return undefined;
}
