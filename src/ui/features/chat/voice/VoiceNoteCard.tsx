import { useStore } from 'zustand';
import type { Attachment, ConversationId, MessageId } from '@/core/domain';
import { localSelectors, sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { formatBytes } from '../lib/attachments';
import { nextVoiceKey, voicePlayKey } from './nextVoice';
import { VoicePlayer } from './VoicePlayer';

/** Largest voice note whose waveform is worked out (about the longest Signal Desktop will decode). */
const MAX_WAVEFORM_BYTES = 12 * 1024 * 1024;

export interface VoiceNoteCardProps {
  conversationId: ConversationId;
  messageId: MessageId;
  authorId: string;
  sentAt: number;
  attachment: Attachment;
  /** The resolved audio URL. */
  url: string;
}

/**
 * A voice note in the timeline: play/pause, the waveform worked out here,
 * scrubbing, the remaining time, speed, and a dot while someone else's note is
 * still unplayed. When one ends, the next voice note below it plays.
 */
export function VoiceNoteCard({
  conversationId,
  messageId,
  authorId,
  sentAt,
  attachment,
  url,
}: VoiceNoteCardProps) {
  const { stores, backend } = useSnowdrop();
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const playedKey = `${authorId}\u0000${sentAt}`;
  const played = useStore(stores.local, localSelectors.voiceNotePlayed(playedKey));
  const incoming = authorId !== selfId;
  const read = backend.readAttachmentBlob;
  const canRead = read !== undefined && (attachment.size ?? 0) <= MAX_WAVEFORM_BYTES;

  /** The next voice note in this conversation, if its message is loaded. */
  const nextKey = (): string | undefined => {
    const window = stores.messages.getState().windows[conversationId];
    return window ? nextVoiceKey(window.ids, window.byId, messageId) : undefined;
  };

  return (
    <VoicePlayer
      playKey={voicePlayKey(messageId, attachment.id)}
      url={url}
      waveform={{
        keys: [`url:${url}`, `att:${attachment.id}`],
        read: canRead
          ? () => read.call(backend, conversationId, attachment, { maxBytes: MAX_WAVEFORM_BYTES })
          : undefined,
      }}
      sizeText={formatBytes(attachment.size)}
      unplayed={incoming && !played}
      onPlayed={() => {
        if (incoming) stores.local.getState().markVoiceNotePlayed(playedKey);
      }}
      nextKey={nextKey}
    />
  );
}
