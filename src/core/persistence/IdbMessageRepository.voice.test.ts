import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationIdFor } from '@/core/domain/testing';
import { webCryptoCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';

let repo: IdbMessageRepository | undefined;
afterEach(() => {
  repo?.close();
  repo = undefined;
});

describe('outbox: voice notes', () => {
  it('a queued voice note is still a voice note after a restart', async () => {
    const cipher = await webCryptoCipher(crypto.getRandomValues(new Uint8Array(32)));
    repo = await IdbMessageRepository.open('snowdrop-voice-outbox-test', cipher);
    await repo.putOutbox({
      nonce: 'n1',
      createdAt: 1,
      input: {
        conversationId: conversationIdFor('g'),
        body: '',
        ranges: [],
        attachments: [
          {
            fileName: 'voice-note.mp3',
            contentType: 'audio/mpeg',
            data: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
            voiceNote: true,
          },
          { fileName: 'a.txt', contentType: 'text/plain', data: new Blob(['hi']) },
        ],
      },
    });
    const [entry] = await repo.listOutbox();
    expect(entry?.attachmentsLost).toBeUndefined();
    expect(entry?.input.attachments?.map((a) => a.voiceNote)).toEqual([true, undefined]);
    expect(entry?.input.attachments?.[0]?.data.size).toBe(3);
  });
});
