import { useCallback, useEffect, useRef, useState } from 'react';
import { attachmentProblem, rejectedFilesMessage, type AttachmentProblem } from '@/core/domain';
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
 * The composer's pending attachments: the list, the object-URL previews (released when an
 * attachment goes and on unmount), the voice-alone rule and image measuring.
 */
export function useAttachments(setError: (error: string | null) => void) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const latest = useRef(attachments);
  useEffect(() => {
    latest.current = attachments;
  }, [attachments]);
  // Previews are object URLs: release whatever is still pending on unmount.
  useEffect(
    () => () => {
      for (const a of latest.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      // Signal sends a voice message alone.
      if (latest.current.some((a) => a.voiceNote)) {
        setError(VOICE_ALONE);
        return;
      }
      // A file that can never be sent never becomes a pending attachment; the rest of a drop stays.
      const rejected: { name: string; problem: AttachmentProblem }[] = [];
      const accepted = files.filter((file) => {
        const problem = attachmentProblem(file);
        if (problem) rejected.push({ name: file.name, problem });
        return problem === null;
      });
      if (rejected.length > 0) setError(rejectedFilesMessage(rejected));
      if (accepted.length === 0) return;
      const added = accepted.map((file): PendingAttachment => ({
        id: `att-${++attachmentSeq}`,
        file,
        ...(isPreviewable(file) ? { previewUrl: URL.createObjectURL(file) } : {}),
      }));
      setAttachments((current) => [...current, ...added]);
      // Measure images so the sent message reserves the right box before it loads.
      for (const a of added) {
        if (!a.previewUrl || typeof Image === 'undefined') continue;
        const img = new Image();
        img.onload = () => {
          setAttachments((current) =>
            current.map((x) =>
              x.id === a.id ? { ...x, width: img.naturalWidth, height: img.naturalHeight } : x,
            ),
          );
        };
        img.src = a.previewUrl;
      }
    },
    [setError],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const gone = current.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return current.filter((a) => a.id !== id);
    });
  }, []);

  /** Empties the tray, releasing its previews. */
  const clearAttachments = () => {
    for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    latest.current = [];
    setAttachments([]);
  };

  /** Puts back what a send that did not go out took (never over files added meanwhile). */
  const restoreAttachments = (held: readonly PendingAttachment[]) => {
    if (latest.current.length > 0 || held.length === 0) return;
    // The files are still held; their previews were released with the tray, so make new ones.
    const back = held.map((a) => ({
      ...a,
      ...(a.previewUrl !== undefined || a.voiceNote === true
        ? { previewUrl: URL.createObjectURL(a.file) }
        : {}),
    }));
    latest.current = back;
    setAttachments(back);
  };

  /** A voice note goes alone: it replaces the tray, releasing what it replaces. */
  const addVoiceNote = (recording: VoiceRecording) => {
    const pending = voicePending(recording);
    for (const a of latest.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    const next = [{ ...pending, previewUrl: URL.createObjectURL(pending.file) }];
    latest.current = next;
    setAttachments(next);
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
