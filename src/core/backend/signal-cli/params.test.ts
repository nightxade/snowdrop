// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { directConversationId, groupConversationId, type ConversationId } from '@/core/domain';
import { base64ToBytes, bytesToBase64, encodeOutgoing } from './attachments';
import { messageParams, recipientFailures, targetParams, toDataUri } from './params';

const SELF = new Set(['self-aci', '+15550000000']);

describe('targetParams', () => {
  it('addresses DMs, groups and note-to-self', () => {
    expect(targetParams(directConversationId('alice'), SELF)).toEqual({ recipient: ['alice'] });
    expect(targetParams(groupConversationId('G=='), SELF)).toEqual({ groupId: 'G==' });
    expect(targetParams(directConversationId('+15550000000'), SELF)).toEqual({ noteToSelf: true });
    expect(() => targetParams('nope' as ConversationId, SELF)).toThrow(/Not a conversation/u);
  });
});

describe('messageParams', () => {
  it('encodes styles and mentions as start:length:X strings', () => {
    const body = 'hi ￼, **no**';
    expect(
      messageParams({
        body,
        ranges: [
          { start: 3, length: 1, mentionId: 'bob-aci' },
          { start: 0, length: 2, style: 'bold' },
          { start: 6, length: 6, style: 'spoiler' },
          { start: 1, length: 0, style: 'italic' },
        ],
      }),
    ).toEqual({
      message: body,
      textStyle: ['0:2:BOLD', '6:6:SPOILER'],
      mention: ['3:1:bob-aci'],
    });
  });

  it('adds quote params (with the quoted text styles/mentions) and edit timestamp', () => {
    expect(
      messageParams({
        body: 'yes',
        ranges: [],
        quote: {
          authorId: 'alice',
          sentAt: 1000,
          text: 'you ￼?',
          ranges: [
            { start: 4, length: 1, mentionId: 'me' },
            { start: 0, length: 3, style: 'italic' },
          ],
        },
        attachments: ['data:text/plain;filename=a.txt;base64,aGk='],
        editTimestamp: 777,
      }),
    ).toEqual({
      message: 'yes',
      attachment: ['data:text/plain;filename=a.txt;base64,aGk='],
      editTimestamp: 777,
      quoteTimestamp: 1000,
      quoteAuthor: 'alice',
      quoteMessage: 'you ￼?',
      quoteTextStyle: ['0:3:ITALIC'],
      quoteMention: ['4:1:me'],
    });
  });
});

describe('attachments', () => {
  it('builds RFC 2397 data URIs with an escaped filename and a safe media type', () => {
    expect(toDataUri('image/png', 'my pic;1,x.png', 'AAA=')).toBe(
      'data:image/png;filename=my%20pic%3B1%2Cx.png;base64,AAA=',
    );
    expect(toDataUri('', 'a', 'AA==')).toMatch(/^data:application\/octet-stream;/u);
    expect(toDataUri('text/plain;charset=utf-8', 'a', 'AA==')).toMatch(
      /^data:application\/octet-stream;/u,
    );
  });

  it('round-trips base64 for large binary buffers', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('keeps a renderable data: URL for small files only', async () => {
    const small = await encodeOutgoing(
      { fileName: 'a.txt', contentType: 'text/plain', data: new Blob(['hi']) },
      'local:1',
    );
    expect(small.param).toBe('data:text/plain;filename=a.txt;base64,aGk=');
    expect(small.attachment).toEqual({
      id: 'local:1',
      contentType: 'text/plain',
      fileName: 'a.txt',
      size: 2,
      url: 'data:text/plain;base64,aGk=',
    });
    const big = await encodeOutgoing(
      {
        fileName: 'b.bin',
        contentType: 'application/zip',
        data: new Blob([new Uint8Array(2_000_000)]),
      },
      'local:2',
    );
    expect(big.attachment.url).toBeUndefined();
  });
});

describe('recipientFailures', () => {
  it('maps every failure type and ignores successes', () => {
    const address = (uuid: string) => ({ uuid, number: undefined, username: undefined });
    const item = (uuid: string, type: string) => ({
      recipientAddress: address(uuid),
      groupId: undefined,
      type,
      retryAfterSeconds: undefined,
    });
    expect(
      recipientFailures({
        timestamp: 1,
        results: [
          item('a', 'SUCCESS'),
          item('b', 'NETWORK_FAILURE'),
          item('c', 'UNREGISTERED_FAILURE'),
          item('d', 'IDENTITY_FAILURE'),
          item('e', 'RATE_LIMIT_FAILURE'),
          item('f', 'INVALID_PRE_KEY_FAILURE'),
        ],
      }),
    ).toEqual([
      { recipientId: 'b', reason: 'network' },
      { recipientId: 'c', reason: 'unregistered' },
      { recipientId: 'd', reason: 'untrusted-identity' },
      { recipientId: 'e', reason: 'rate-limited' },
      { recipientId: 'f', reason: 'unknown' },
    ]);
  });
});
