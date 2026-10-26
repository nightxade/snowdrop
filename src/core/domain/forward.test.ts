import { describe, expect, it } from 'vitest';
import { isForwardEditable, isForwardable, MAX_FORWARD_TARGETS } from './forward';
import { messageId, pendingMessageId } from './ids';
import type { Message } from './types';

const base = (patch: Partial<Message> = {}): Message => ({
  id: messageId('a', 1),
  conversationId: 'dm:a' as Message['conversationId'],
  authorId: 'a',
  sentAt: 1,
  receivedAt: 1,
  body: 'hello',
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'sent',
  kind: 'normal',
  ...patch,
});

describe('isForwardable', () => {
  it('accepts text, attachments and stickers', () => {
    expect(isForwardable(base())).toBe(true);
    expect(
      isForwardable(base({ body: '', attachments: [{ id: 'x', contentType: 'image/png' }] })),
    ).toBe(true);
    expect(isForwardable(base({ body: '', sticker: { packId: 'ab', stickerId: 1 } }))).toBe(true);
  });

  it('refuses polls, deleted messages, system lines and empty ones', () => {
    expect(
      isForwardable(
        base({
          body: '',
          poll: { question: 'q', options: ['a', 'b'], allowMultiple: false, votes: [] },
        }),
      ),
    ).toBe(false);
    expect(isForwardable(base({ deleted: true }))).toBe(false);
    expect(isForwardable(base({ kind: 'system' }))).toBe(false);
    expect(isForwardable(base({ body: '  \n' }))).toBe(false);
  });

  it('refuses our own messages that are unsent or failed', () => {
    expect(isForwardable(base({ id: pendingMessageId('n') }))).toBe(false);
    expect(isForwardable(base({ status: 'failed' }))).toBe(false);
  });
});

describe('isForwardEditable', () => {
  it('locks stickers and voice messages, like Desktop', () => {
    expect(isForwardEditable(base())).toBe(true);
    expect(isForwardEditable(base({ sticker: { packId: 'ab', stickerId: 1 } }))).toBe(false);
    expect(
      isForwardEditable(
        base({ attachments: [{ id: 'v', contentType: 'audio/aac', voiceNote: true }] }),
      ),
    ).toBe(false);
    expect(
      isForwardEditable(
        base({ attachments: [{ id: 'v', contentType: 'image/png', fileName: 'a.png' }] }),
      ),
    ).toBe(true);
  });

  it('allows at most five chats, as Desktop does', () => {
    expect(MAX_FORWARD_TARGETS).toBe(5);
  });
});
