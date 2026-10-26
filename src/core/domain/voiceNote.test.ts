import { describe, expect, it } from 'vitest';
import { isVoiceNote } from './voiceNote';

describe('isVoiceNote', () => {
  it('trusts the sender flag', () => {
    expect(isVoiceNote({ contentType: 'audio/aac', fileName: 'a.aac', voiceNote: true })).toBe(
      true,
    );
  });
  it('treats an audio file with no name as one (older Android clients)', () => {
    expect(isVoiceNote({ contentType: 'audio/aac' })).toBe(true);
    expect(isVoiceNote({ contentType: 'Audio/Mpeg' })).toBe(true);
  });
  it('leaves named audio, and anything else, alone', () => {
    expect(isVoiceNote({ contentType: 'audio/mpeg', fileName: 'song.mp3' })).toBe(false);
    expect(isVoiceNote({ contentType: 'image/png' })).toBe(false);
    expect(isVoiceNote({ contentType: 'video/mp4', voiceNote: false })).toBe(false);
  });
});
