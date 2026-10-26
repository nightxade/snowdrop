import { describe, expect, it } from 'vitest';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { previewText } from './preview';

const conv = conversationIdFor('g');
const names: Record<string, string> = { a: 'Mira Okafor', me: 'Me' };
const ctx = { selfId: 'me', isGroup: true, nameFor: (id: string) => names[id] ?? '?' };

describe('previewText', () => {
  it('prefixes the author in groups and "You" for own messages', () => {
    expect(
      previewText(makeMessage({ conversationId: conv, authorId: 'a', body: 'hi  there' }), ctx),
    ).toBe('Mira: hi there');
    expect(
      previewText(makeMessage({ conversationId: conv, authorId: 'me', body: 'ok' }), ctx),
    ).toBe('You: ok');
    expect(
      previewText(makeMessage({ conversationId: conv, authorId: 'a', body: 'x' }), {
        ...ctx,
        isGroup: false,
      }),
    ).toBe('x');
  });

  it('describes attachments, deletions and system lines', () => {
    const photo = makeMessage({
      authorId: 'a',
      body: '',
      attachments: [{ id: '1', contentType: 'image/png' }],
    });
    expect(previewText(photo, ctx)).toBe('Mira: Photo');
    expect(previewText(makeMessage({ authorId: 'a', deleted: true }), ctx)).toBe(
      'Mira: Message deleted',
    );
    expect(previewText(makeMessage({ kind: 'system', systemText: 'Mira joined' }), ctx)).toBe(
      'Mira joined',
    );
    expect(previewText(undefined, ctx)).toBe('');
  });

  it('describes a sticker, with its emoji when known', () => {
    const sticker = makeMessage({
      authorId: 'a',
      body: '',
      sticker: { packId: 'ab', stickerId: 1 },
    });
    expect(previewText(sticker, ctx)).toBe('Mira: Sticker');
    const withEmoji = makeMessage({
      authorId: 'a',
      body: '',
      sticker: { packId: 'ab', stickerId: 1, emoji: '🎉' },
    });
    expect(previewText(withEmoji, ctx)).toBe('Mira: 🎉 Sticker');
  });

  it('describes a poll as Signal Desktop does: its question, with the chart marker', () => {
    const poll = makeMessage({
      authorId: 'a',
      body: '',
      poll: { question: 'Where to eat?', options: ['a', 'b'], allowMultiple: true, votes: [] },
    });
    expect(previewText(poll, ctx)).toBe('Mira: 📊 Poll: Where to eat?');
    expect(previewText({ ...poll, authorId: 'me' }, ctx)).toBe('You: 📊 Poll: Where to eat?');
  });
});
