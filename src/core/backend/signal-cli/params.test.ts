// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { directConversationId, groupConversationId, type ConversationId } from '@/core/domain';
import {
  AttachmentResolver,
  base64ToBytes,
  bytesToBase64,
  encodeOutgoing,
  MAX_ATTACHMENT_BYTES,
  safeMediaType,
} from './attachments';
import {
  messageParams,
  pinDurationParam,
  quoteAttachmentParams,
  recipientFailures,
  targetParams,
  toDataUri,
} from './params';
import { JsonRpcClient } from './rpc';
import { FakeDaemon } from './testing';

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

  it('adds customEmoji as {name, attachment} pairs, omitted when empty', () => {
    expect(
      messageParams({
        body: 'nice :party:',
        ranges: [],
        customEmoji: [{ name: 'party', dataUrl: 'data:image/png;base64,aGk=' }],
      }),
    ).toEqual({
      message: 'nice :party:',
      customEmoji: [{ name: 'party', attachment: 'data:image/png;base64,aGk=' }],
    });
    expect(messageParams({ body: 'hi', ranges: [], customEmoji: [] })).toEqual({ message: 'hi' });
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

  it('keeps only a thumbnail preview, for images only', async () => {
    const text = await encodeOutgoing(
      { fileName: 'a.txt', contentType: 'text/plain', data: new Blob(['hi']) },
      'local:1',
    );
    expect(text.param).toBe('data:text/plain;filename=a.txt;base64,aGk=');
    expect(text.attachment).toEqual({
      id: 'local:1',
      contentType: 'text/plain',
      fileName: 'a.txt',
      size: 2,
    });

    const thumbnailer = vi.fn(() =>
      Promise.resolve({ url: 'data:image/webp;base64,AAAA', width: 4000, height: 3000 }),
    );
    const photo = await encodeOutgoing(
      { fileName: 'p.jpg', contentType: 'image/jpeg', data: new Blob([new Uint8Array(10)]) },
      'local:2',
      thumbnailer,
    );
    expect(photo.attachment).toMatchObject({
      url: 'data:image/webp;base64,AAAA',
      width: 4000,
      height: 3000,
    });
    // SVG is not a raster image we preview (it can carry script).
    await encodeOutgoing(
      { fileName: 'x.svg', contentType: 'image/svg+xml', data: new Blob(['<svg/>']) },
      'local:3',
      thumbnailer,
    );
    expect(thumbnailer).toHaveBeenCalledTimes(1);
  });

  it('rejects empty and oversized files before encoding', async () => {
    await expect(
      encodeOutgoing({ fileName: 'e', contentType: 'text/plain', data: new Blob([]) }, 'x'),
    ).rejects.toThrow(/empty/u);
    const huge = new Blob(['x']);
    Object.defineProperty(huge, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    await expect(
      encodeOutgoing({ fileName: 'h', contentType: 'video/mp4', data: huge }, 'x'),
    ).rejects.toThrow(/100 MB/u);
    expect(() => toDataUri('text/plain', 'a', '')).toThrow(/Empty/u);
  });

  it('labels downloaded bytes only with allow-listed media types', () => {
    expect(safeMediaType('image/png')).toBe('image/png');
    expect(safeMediaType('Video/MP4; codecs=avc1')).toBe('video/mp4');
    expect(safeMediaType('image/svg+xml')).toBe('application/octet-stream');
    expect(safeMediaType('text/html')).toBe('application/octet-stream');
    expect(safeMediaType('application/xhtml+xml')).toBe('application/octet-stream');
  });

  it('serves resolved attachments as opaque bytes unless the type is safe', async () => {
    const daemon = new FakeDaemon().reply('getAttachment', { data: 'PHN2Zy8+' });
    const blobs: Blob[] = [];
    const resolver = new AttachmentResolver({
      rpc: new JsonRpcClient({ baseUrl: '', fetch: daemon.fetch }),
      createObjectUrl: (blob) => {
        blobs.push(blob);
        return `blob:${blobs.length}`;
      },
      revokeObjectUrl: () => undefined,
    });
    await resolver.resolve({ id: 'a', contentType: 'image/svg+xml' });
    await resolver.resolve({ id: 'b', contentType: 'image/png' });
    expect(blobs.map((b) => b.type)).toEqual(['application/octet-stream', 'image/png']);
  });

  it('keeps a newer download when clear() races an older one', async () => {
    let answer: (v: Response) => void = () => undefined;
    const pending: Promise<Response>[] = [];
    const fetch = () => {
      const p = new Promise<Response>((r) => (answer = r));
      pending.push(p);
      return p;
    };
    const ok = () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data: 'AA==' } }));
    let n = 0;
    const resolver = new AttachmentResolver({
      rpc: new JsonRpcClient({ baseUrl: '', fetch }),
      createObjectUrl: () => `blob:${++n}`,
      revokeObjectUrl: () => undefined,
    });
    const first = resolver.resolve({ id: 'a', contentType: 'image/png' });
    const answerFirst = answer;
    resolver.clear();
    const second = resolver.resolve({ id: 'a', contentType: 'image/png' });
    answerFirst(ok());
    await expect(first).rejects.toThrow(/Disconnected/u);
    // The second request must still be the shared in-flight one.
    expect(resolver.resolve({ id: 'a', contentType: 'image/png' })).toBe(second);
    answer(ok());
    await expect(second).resolves.toBe('blob:2');
    expect(pending).toHaveLength(2);
  });

  it('forceRefresh bypasses the cache and re-downloads, revoking the stale URL', async () => {
    let calls = 0;
    const daemon = new FakeDaemon().handle('getAttachment', () => {
      calls++;
      return { result: { data: calls === 1 ? 'AAA=' : 'BBB=' } };
    });
    const revoked: string[] = [];
    let n = 0;
    const resolver = new AttachmentResolver({
      rpc: new JsonRpcClient({ baseUrl: '', fetch: daemon.fetch }),
      createObjectUrl: () => `blob:${++n}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const first = await resolver.resolve({ id: 'a', contentType: 'image/png' });
    expect(first).toBe('blob:1');

    // Without forceRefresh: a cache hit, no second RPC call — this is what
    // would make a plain "ask again" retry of a corrupt/stuck file a no-op.
    await resolver.resolve({ id: 'a', contentType: 'image/png' });
    expect(calls).toBe(1);

    // forceRefresh: always a fresh download, and the stale cached URL is
    // revoked immediately rather than being handed out to anything else.
    const second = await resolver.resolve(
      { id: 'a', contentType: 'image/png' },
      {},
      { forceRefresh: true },
    );
    expect(second).toBe('blob:2');
    expect(calls).toBe(2);
    expect(revoked).toContain('blob:1');
  });

  it('rejects an oversized attachment as kind too-large, without calling the daemon', async () => {
    const daemon = new FakeDaemon();
    const resolver = new AttachmentResolver({
      rpc: new JsonRpcClient({ baseUrl: '', fetch: daemon.fetch }),
      maxBytes: 10,
    });

    await expect(
      resolver.resolve({ id: 'a', contentType: 'image/png', size: 11 }),
    ).rejects.toMatchObject({ kind: 'too-large' });
    expect(daemon.calls).toHaveLength(0);
  });
});

describe('quote attachments and pin duration', () => {
  it('encodes quoted attachments without extra colons', () => {
    expect(
      quoteAttachmentParams([
        { contentType: 'image/jpeg', fileName: 'a:b.jpg' },
        { contentType: 'audio/aac' },
        { contentType: 'weird' },
      ]),
    ).toEqual(['image/jpeg:a_b.jpg', 'audio/aac']);
    expect(
      messageParams({
        body: '',
        ranges: [],
        quote: { authorId: 'a', sentAt: 1, text: '', attachments: [{ contentType: 'image/png' }] },
      }).quoteAttachment,
    ).toEqual(['image/png']);
  });

  it('clamps pin durations to a Java int, -1 meaning forever', () => {
    expect(pinDurationParam(undefined)).toBe(-1);
    expect(pinDurationParam(0)).toBe(-1);
    expect(pinDurationParam(86_400.7)).toBe(86_400);
    expect(pinDurationParam(1e12)).toBe(2_147_483_647);
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
