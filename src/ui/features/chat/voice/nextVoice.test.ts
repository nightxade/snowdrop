import { describe, expect, it } from 'vitest';
import { messageId, type Message, type MessageId } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { nextVoiceKey, voicePlayKey } from './nextVoice';

const voice = { id: 'v', contentType: 'audio/mpeg', fileName: 'voice-note.mp3', voiceNote: true };

function window(...messages: Message[]) {
  return {
    ids: messages.map((m) => m.id),
    byId: Object.fromEntries(messages.map((m) => [m.id, m])) as Record<MessageId, Message>,
  };
}

describe('nextVoiceKey', () => {
  it('finds the next voice note down the conversation, skipping other messages and other audio', () => {
    const a = makeMessage({ sentAt: 1, attachments: [voice] });
    const text = makeMessage({ sentAt: 2, body: 'hi' });
    const song = makeMessage({
      sentAt: 3,
      attachments: [{ id: 's', contentType: 'audio/mpeg', fileName: 'song.mp3' }],
    });
    const b = makeMessage({ sentAt: 4, attachments: [voice] });
    const w = window(a, text, song, b);
    expect(nextVoiceKey(w.ids, w.byId, a.id)).toBe(voicePlayKey(b.id, 'v'));
  });

  it('counts an audio file with no name as a voice note, as Desktop does', () => {
    const a = makeMessage({ sentAt: 1, attachments: [voice] });
    const unnamed = makeMessage({
      sentAt: 2,
      attachments: [{ id: 'u', contentType: 'audio/aac' }],
    });
    const w = window(a, unnamed);
    expect(nextVoiceKey(w.ids, w.byId, a.id)).toBe(voicePlayKey(unnamed.id, 'u'));
  });

  it('skips deleted messages and stops at the end', () => {
    const a = makeMessage({ sentAt: 1, attachments: [voice] });
    const gone = makeMessage({ sentAt: 2, attachments: [voice], deleted: true });
    const w = window(a, gone);
    expect(nextVoiceKey(w.ids, w.byId, a.id)).toBeUndefined();
    expect(nextVoiceKey(w.ids, w.byId, gone.id)).toBeUndefined();
  });

  it('knows nothing about a message that is not loaded', () => {
    const a = makeMessage({ sentAt: 1, attachments: [voice] });
    const w = window(a);
    expect(nextVoiceKey(w.ids, w.byId, messageId('x', 9))).toBeUndefined();
  });
});
