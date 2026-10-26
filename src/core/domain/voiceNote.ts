/**
 * What counts as a voice note, the way Signal Desktop decides it: the sender's
 * voice-message flag, or (older Android clients never set the flag) an audio
 * file with no file name.
 */
import type { Attachment } from './types';

export function isVoiceNote(
  attachment: Pick<Attachment, 'contentType' | 'fileName' | 'voiceNote'>,
): boolean {
  if (attachment.voiceNote === true) return true;
  return attachment.contentType.toLowerCase().startsWith('audio/') && !attachment.fileName;
}

/** The longest voice note Signal Desktop records: one hour. */
export const VOICE_NOTE_MAX_SECONDS = 60 * 60;
