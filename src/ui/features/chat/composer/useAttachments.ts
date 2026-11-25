import { useCallback, useState } from 'react';
import {
  MAX_ATTACHMENTS,
  attachmentProblem,
  rejectedFilesMessage,
  type AttachmentProblem,
  type ConversationId,
} from '@/core/domain';
import type { VoiceRecording } from '../voice/recorder';
import type { PendingAttachment } from './AttachmentTray';

let attachmentSeq = 0;
let voiceSeq = 0;

const VOICE_ALONE = 'A voice message must have only one attachment.';

/** A recording as a composer attachment (no preview URL yet: only a draft needs one). */
export function voicePending(recording: VoiceRecording): PendingAttachment {
  return {
    id: `voice-${++voiceSeq}`,
    file: new File([recording.blob], 'voice-note.mp3', { type: 'audio/mpeg' }),
    voiceNote: true,
    levels: recording.waveform,
    duration: recording.durationSeconds,
  };
}

/** Raster images get a tray thumbnail and an optimistic preview (never SVG). */
function isPreviewable(file: File): boolean {
  return file.type.startsWith('image/') && file.type !== 'image/svg+xml';
}

/**
 * Staged files per conversation, kept for the session (a File cannot be stored with the text
 * drafts, so a reload drops them). Held by whoever owns the app's stores, so a new app starts empty.
 */
export type StagedFiles = Map<ConversationId, PendingAttachment[]>;

const memory = new WeakMap<object, StagedFiles>();

/** The staged files of the app that owns `owner`. */
export function stagedFilesOf(owner: object): StagedFiles {
  let held = memory.get(owner);
  if (!held) memory.set(owner, (held = new Map<ConversationId, PendingAttachment[]>()));
  return held;
}

/**
 * The composer's pending attachments: the list, the object-URL previews (released when an
 * attachment goes or is sent, kept valid while the chat is away), the voice-alone rule and image
 * measuring. What is staged belongs to the conversation's draft: it is still there when the user
 * comes back to the chat.
 */
export function useAttachments(
  conversationId: ConversationId,
  held: StagedFiles,
  setError: (error: string | null) => void,
) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>(
    () => held.get(conversationId) ?? [],
  );
  /** What is staged right now (the memory is the truth: it outlives this composer). */
  const current = useCallback(() => held.get(conversationId) ?? [], [held, conversationId]);
  const commit = useCallback(
    (next: PendingAttachment[]) => {
      if (next.length === 0) held.delete(conversationId);
      else held.set(conversationId, next);
      setAttachments(next);
    },
    [held, conversationId],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      // Signal sends a voice message alone.
      if (current().some((a) => a.voiceNote)) {
        setError(VOICE_ALONE);
        return;
      }
      // A file that can never be sent never becomes a pending attachment; the rest of a drop stays.
      const rejected: { name: string; problem: AttachmentProblem }[] = [];
      // A message carries at most MAX_ATTACHMENTS: the files that fit stay, in order.
      let room = MAX_ATTACHMENTS - current().length;
      const accepted = files.filter((file) => {
        const problem = attachmentProblem(file) ?? (room <= 0 ? 'too-many' : null);
        if (problem) rejected.push({ name: file.name, problem });
        else room -= 1;
        return problem === null;
      });
      if (rejected.length > 0) setError(rejectedFilesMessage(rejected));
      if (accepted.length === 0) return;
      const added = accepted.map((file): PendingAttachment => ({
        id: `att-${++attachmentSeq}`,
        file,
        ...(isPreviewable(file) ? { previewUrl: URL.createObjectURL(file) } : {}),
      }));
      commit([...current(), ...added]);
      // Measure images so the sent message reserves the right box before it loads.
      for (const a of added) {
        if (!a.previewUrl || typeof Image === 'undefined') continue;
        const img = new Image();
        img.onload = () => {
          // Still staged? (it may have been removed or sent meanwhile.)
          if (!current().some((x) => x.id === a.id)) return;
          commit(
            current().map((x) =>
              x.id === a.id ? { ...x, width: img.naturalWidth, height: img.naturalHeight } : x,
            ),
          );
        };
        img.src = a.previewUrl;
      }
    },
    [setError, current, commit],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      const gone = current().find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      commit(current().filter((a) => a.id !== id));
    },
    [current, commit],
  );

  /** Empties the tray, releasing its previews. */
  const clearAttachments = () => {
    for (const a of current()) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    commit([]);
  };

  /** Puts back what a send that did not go out took (never over files added meanwhile). */
  const restoreAttachments = (back: readonly PendingAttachment[]) => {
    if (current().length > 0 || back.length === 0) return;
    // The files are still held; their previews were released with the tray, so make new ones.
    commit(
      back.map((a) => ({
        ...a,
        ...(a.previewUrl !== undefined || a.voiceNote === true
          ? { previewUrl: URL.createObjectURL(a.file) }
          : {}),
      })),
    );
  };

  /** A voice note goes alone: it replaces the tray, releasing what it replaces. */
  const addVoiceNote = (recording: VoiceRecording) => {
    const pending = voicePending(recording);
    for (const a of current()) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    commit([{ ...pending, previewUrl: URL.createObjectURL(pending.file) }]);
  };

  return {
    attachments,
    addFiles,
    removeAttachment,
    addVoiceNote,
    clearAttachments,
    restoreAttachments,
  };
}
