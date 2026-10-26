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
  stickerParam,
  summariseReadReplies,
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

  it('flags the send as a voice note only with an attachment to flag', () => {
    const attachments = ['data:audio/mpeg;filename=voice-note.mp3;base64,AA=='];
    expect(messageParams({ body: '', ranges: [], attachments, voiceNote: true })).toEqual({
      message: '',
      attachment: attachments,
      voiceNote: true,
    });
    expect(messageParams({ body: '', ranges: [], attachments })).not.toHaveProperty('voiceNote');
    expect(messageParams({ body: 'hi', ranges: [], voiceNote: true })).toEqual({ message: 'hi' });
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
    expect(toDataUri('not a type', 'a', 'AA==')).toMatch(/^data:application\/octet-stream;/u);
  });

  it('strips media-type parameters instead of rejecting the type (a recorder says audio/webm;codecs=opus)', () => {
    expect(toDataUri('audio/webm;codecs=opus', 'v.webm', 'AA==')).toBe(
      'data:audio/webm;filename=v.webm;base64,AA==',
    );
    expect(toDataUri('text/plain; charset=utf-8', 'a', 'AA==')).toBe(
      'data:text/plain;filename=a;base64,AA==',
    );
    // Whatever follows the first `;` can't smuggle another data-URI parameter in.
    expect(toDataUri('audio/mpeg;filename=evil;base64', 'v', 'AA==')).toBe(
      'data:audio/mpeg;filename=v;base64,AA==',
    );
  });

  it('round-trips base64 for large binary buffers', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('records the voice-note flag on the local copy of the attachment', async () => {
    const voice = await encodeOutgoing(
      {
        fileName: 'voice-note.mp3',
        contentType: 'audio/mpeg',
        data: new Blob([new Uint8Array(4)]),
        voiceNote: true,
      },
      'local:v',
    );
    expect(voice.param).toMatch(/^data:audio\/mpeg;filename=voice-note\.mp3;base64,/u);
    expect(voice.attachment).toEqual({
      id: 'local:v',
      contentType: 'audio/mpeg',
      fileName: 'voice-note.mp3',
      size: 4,
      voiceNote: true,
    });
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

  /** A downloaded blob of exactly `n` bytes, for exercising `maxCacheBytes`. */
  const sized = (n: number): string => bytesToBase64(new Uint8Array(n));

  it('evicts least-recently-used entries over the byte budget, skipping ones still in use', async () => {
    const sizes: Record<string, number> = { a: 40, b: 40, c: 40, d: 40 };
    const daemon = new FakeDaemon().handle('getAttachment', (params) => ({
      result: { data: sized(sizes[params.id as string] ?? 0) },
    }));
    const revoked: string[] = [];
    let n = 0;
    const resolver = new AttachmentResolver({
      rpc: new JsonRpcClient({ baseUrl: '', fetch: daemon.fetch }),
      maxCacheBytes: 100,
      createObjectUrl: () => `blob:${++n}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const a = await resolver.resolve({ id: 'a', contentType: 'image/png' });
    const b = await resolver.resolve({ id: 'b', contentType: 'image/png' });
    expect(revoked).toEqual([]); // 80 bytes total, under the 100-byte budget

    // "a" is shown in an open lightbox: a download that pushes the cache
    // over budget must skip it and evict the next-oldest unreferenced entry.
    resolver.retain('a');
    await resolver.resolve({ id: 'c', contentType: 'image/png' }); // 120 bytes total
    expect(revoked).toEqual([b]); // "b" was the oldest entry not in use

    // Releasing "a" doesn't evict it by itself (a + c is still only 80 bytes)...
    resolver.release('a');
    expect(revoked).toEqual([b]);

    // ...but a later download that pushes the cache over budget again now
    // evicts it too, since nothing retains it any more.
    await resolver.resolve({ id: 'd', contentType: 'image/png' }); // 120 bytes total
    expect(revoked).toEqual([b, a]);
  });

  it('still evicts by entry count under the byte budget', async () => {
    const daemon = new FakeDaemon().reply('getAttachment', { data: sized(1) });
    const revoked: string[] = [];
    let n = 0;
    const resolver = new AttachmentResolver({
      rpc: new JsonRpcClient({ baseUrl: '', fetch: daemon.fetch }),
      maxEntries: 2,
      maxCacheBytes: 1_000_000,
      createObjectUrl: () => `blob:${++n}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });

    const a = await resolver.resolve({ id: 'a', contentType: 'image/png' });
    await resolver.resolve({ id: 'b', contentType: 'image/png' });
    await resolver.resolve({ id: 'c', contentType: 'image/png' });
    expect(revoked).toEqual([a]);
  });

  it('a single file larger than the whole budget is kept while retained, and evicted on release', async () => {
    const daemon = new FakeDaemon().reply('getAttachment', { data: sized(500) });
    const revoked: string[] = [];
    let n = 0;
    const resolver = new AttachmentResolver({
      rpc: new JsonRpcClient({ baseUrl: '', fetch: daemon.fetch }),
      maxCacheBytes: 100,
      createObjectUrl: () => `blob:${++n}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });

    resolver.retain('big');
    const url = await resolver.resolve({ id: 'big', contentType: 'video/mp4' });
    expect(revoked).toEqual([]); // 500 bytes alone is already over the 100-byte budget, but it's in use

    resolver.release('big');
    expect(revoked).toEqual([url]); // nothing references it any more
  });

  it('two retains on the same entry both need releasing before it becomes evictable', async () => {
    const sizes: Record<string, number> = { a: 60, b: 60 };
    const daemon = new FakeDaemon().handle('getAttachment', (params) => ({
      result: { data: sized(sizes[params.id as string] ?? 0) },
    }));
    const revoked: string[] = [];
    let n = 0;
    const resolver = new AttachmentResolver({
      rpc: new JsonRpcClient({ baseUrl: '', fetch: daemon.fetch }),
      maxCacheBytes: 100,
      createObjectUrl: () => `blob:${++n}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });

    // Two mounted components (e.g. a grid thumbnail and an open lightbox)
    // both show "a"; "b" is retained once, by something else entirely.
    resolver.retain('a');
    resolver.retain('a');
    resolver.retain('b');
    const a = await resolver.resolve({ id: 'a', contentType: 'image/png' });
    await resolver.resolve({ id: 'b', contentType: 'image/png' }); // 120 bytes total, over budget
    expect(revoked).toEqual([]); // both entries are in use; neither is evictable

    resolver.release('a');
    expect(revoked).toEqual([]); // one retain on "a" remains, and "b" is still retained

    resolver.release('a');
    expect(revoked).toEqual([a]); // "a" is now unreferenced; "b" is still in use and survives
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

describe('stickerParam', () => {
  it('joins a hex pack id and a sticker id the way signal-cli parses them', () => {
    expect(stickerParam('9acc9e8a', 0)).toBe('9acc9e8a:0');
    expect(messageParams({ body: '', ranges: [], sticker: '9acc9e8a:4' })).toMatchObject({
      message: '',
      sticker: '9acc9e8a:4',
    });
  });

  it.each([
    ['', 1],
    ['AB12', 1],
    ['ab12:3', 1],
    ['ab12 --message x', 1],
    ['ab12', -1],
    ['ab12', 1.5],
    ['ab12', Number.NaN],
  ])('rejects %j / %j', (packId, stickerId) => {
    expect(() => stickerParam(packId, stickerId)).toThrow();
  });
});

describe('summariseReadReplies', () => {
  const item = (type: string) => ({ type, recipientAddress: { uuid: 'someone' } });

  it('reads the sync field and the receipt outcomes', () => {
    expect(
      summariseReadReplies([{ timestamp: 1, results: [item('SUCCESS')], sync: 'success' }]),
    ).toEqual({ receipt: 'success', sync: 'success' });
  });

  it('a sync-only reply has no receipt', () => {
    expect(summariseReadReplies([{ timestamp: 0, results: [], sync: 'network' }])).toEqual({
      receipt: 'none',
      sync: 'network',
    });
  });

  it('an older build has no sync field: unreported, not a failure', () => {
    expect(summariseReadReplies([{ timestamp: 1, results: [item('SUCCESS')] }])).toEqual({
      receipt: 'success',
      sync: 'unreported',
    });
    expect(summariseReadReplies([{ timestamp: 1, results: [], sync: null }]).sync).toBe(
      'unreported',
    );
  });

  it('maps receipt failure types to the reasons send reports', () => {
    const types = {
      NETWORK_FAILURE: 'network',
      UNREGISTERED_FAILURE: 'unregistered',
      IDENTITY_FAILURE: 'untrusted-identity',
      RATE_LIMIT_FAILURE: 'rate-limited',
      INVALID_PRE_KEY_FAILURE: 'unknown',
    };
    for (const [type, reason] of Object.entries(types)) {
      expect(summariseReadReplies([{ results: [item(type)], sync: 'success' }]).receipt).toBe(
        reason,
      );
    }
  });

  it('several authors: the first failure wins over successes', () => {
    expect(
      summariseReadReplies([
        { results: [item('SUCCESS')], sync: 'success' },
        { results: [item('NETWORK_FAILURE')], sync: 'rate-limit' },
        { results: [item('SUCCESS')], sync: 'error' },
      ]),
    ).toEqual({ receipt: 'network', sync: 'rate-limit' });
  });

  it('passes through a sync value it has never seen', () => {
    expect(summariseReadReplies([{ results: [], sync: 'brand-new' }]).sync).toBe('brand-new');
  });

  it('nothing sent, or a reply that is not an object', () => {
    expect(summariseReadReplies([])).toEqual({ receipt: 'none', sync: 'none' });
    expect(summariseReadReplies(['nonsense', null])).toEqual({
      receipt: 'none',
      sync: 'unreported',
    });
  });
});
