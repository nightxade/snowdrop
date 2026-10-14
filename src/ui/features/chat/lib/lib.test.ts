import { describe, expect, it } from 'vitest';
import { MENTION_PLACEHOLDER, parseMarkdownToRanges } from '@/core/domain';
import { encodeMentions, tokensInText } from '../composer/mentionTokens';
import { findTrigger } from '../composer/triggers';
import { formattingMarker } from '../composer/formatting';
import { typingText } from '../composer/TypingLine';
import {
  attachmentFailureCopy,
  attachmentKind,
  classifyAttachmentFailure,
  fitMedia,
  formatBytes,
} from './attachments';
import { createIndexTracker } from './indexTracker';
import { toMarkdown } from './toMarkdown';

const keys = (...k: string[]) => k.map((key) => ({ key }));

describe('createIndexTracker', () => {
  it('shifts firstItemIndex by what was prepended, keyed on existing rows', () => {
    const track = createIndexTracker(1000);
    const first = track(keys('day-a', 'a', 'b'));
    expect(first).toEqual({ firstItemIndex: 1000, epoch: 1 });
    // Older page in the same day: the day divider moves to the new first message.
    const next = track(keys('day-z', 'z', 'y', 'a', 'b'));
    expect(next).toEqual({ firstItemIndex: 998, epoch: 1 });
  });

  it('moves the other way when the top is evicted', () => {
    const track = createIndexTracker(1000);
    track(keys('a', 'b', 'c', 'd'));
    expect(track(keys('c', 'd', 'e')).firstItemIndex).toBe(1002);
  });

  it('keeps the index for appends and in-place changes', () => {
    const track = createIndexTracker(1000);
    track(keys('a', 'b'));
    expect(track(keys('a', 'b', 'c'))).toEqual({ firstItemIndex: 1000, epoch: 1 });
  });

  it('starts a new epoch when the list is replaced', () => {
    const track = createIndexTracker(1000);
    track(keys('a', 'b'));
    expect(track(keys('x', 'y'))).toEqual({ firstItemIndex: 1000, epoch: 2 });
  });
});

describe('mention tokens', () => {
  it('turns known labels into placeholders, ids in document order', () => {
    const tokens = [
      { id: 'sam', label: '@Sam' },
      { id: 'saml', label: '@Sam Lee' },
    ];
    const out = encodeMentions('@Sam Lee and @Sam, not @Samantha', tokens);
    expect(out.text).toBe(`${MENTION_PLACEHOLDER} and ${MENTION_PLACEHOLDER}, not @Samantha`);
    expect(out.mentionIds).toEqual(['saml', 'sam']);
  });

  it('sends an edited label as plain text', () => {
    const out = encodeMentions('@Sa Lee', [{ id: 'saml', label: '@Sam Lee' }]);
    expect(out).toEqual({ text: '@Sa Lee', mentionIds: [] });
  });

  it('recovers tokens from a restored draft', () => {
    const people = [
      { id: 'a', name: 'Ada' },
      { id: 'b', name: 'Bo' },
    ];
    expect(tokensInText('hey @Ada', people)).toEqual([{ id: 'a', label: '@Ada' }]);
  });
});

describe('findTrigger', () => {
  it('finds mentions, emoji and slash commands at the caret', () => {
    expect(findTrigger('hi @sa', 6)).toEqual({ kind: 'mention', query: 'sa', start: 3, end: 6 });
    expect(findTrigger('@', 1)).toEqual({ kind: 'mention', query: '', start: 0, end: 1 });
    expect(findTrigger('nice :fi', 8)).toEqual({ kind: 'emoji', query: 'fi', start: 5, end: 8 });
    expect(findTrigger('/shr', 4)).toEqual({ kind: 'slash', query: 'shr', start: 0, end: 4 });
  });

  it('ignores lookalikes', () => {
    expect(findTrigger('mail a@b', 8)).toBeNull();
    expect(findTrigger('at 10:30', 8)).toBeNull();
    expect(findTrigger('see :p', 6)).toBeNull();
    expect(findTrigger('a /cmd', 6)).toBeNull();
    expect(findTrigger('/shrug hello', 12)).toBeNull();
  });
});

describe('formattingMarker', () => {
  const k = (
    key: string,
    mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'metaKey' | 'altKey', boolean>>,
  ) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });
  it('maps the shortcuts', () => {
    expect(formattingMarker(k('b', { ctrlKey: true }))).toBe('**');
    expect(formattingMarker(k('i', { metaKey: true }))).toBe('*');
    expect(formattingMarker(k('X', { ctrlKey: true, shiftKey: true }))).toBe('~~');
    expect(formattingMarker(k('b', {}))).toBeNull();
  });
});

describe('toMarkdown', () => {
  it('round-trips formatting through the markdown parser', () => {
    const source = '**bold** and *it* and ~~s~~ and `code` and ||spoiler||';
    const parsed = parseMarkdownToRanges(source);
    const md = toMarkdown(parsed.body, parsed.ranges, () => '?').text;
    expect(parseMarkdownToRanges(md)).toEqual(parsed);
  });

  it('escapes literal markers and lists mentions', () => {
    const body = `2*3 ${MENTION_PLACEHOLDER}`;
    const out = toMarkdown(body, [{ start: 4, length: 1, mentionId: 'm' }], () => 'Mira');
    expect(out.text).toBe('2\\*3 @Mira');
    expect(out.mentions).toEqual([{ id: 'm', label: '@Mira' }]);
  });
});

describe('typingText', () => {
  const contacts = {
    a: { id: 'a', name: 'Alex Kim', color: '' },
    s: { id: 's', name: 'Sam Lee', color: '' },
    j: { id: 'j', name: 'Jo', color: '' },
  };
  it('describes one, two and several typers by first name, never yourself', () => {
    expect(typingText([], null, contacts)).toBeNull();
    expect(typingText(['a', 'me'], 'me', contacts)).toBe('Alex is typing…');
    expect(typingText(['a', 's'], 'me', contacts)).toBe('Alex and Sam are typing…');
    expect(typingText(['a', 's', 'j'], 'me', contacts)).toBe('Several people are typing…');
  });
});

describe('attachments', () => {
  it('only renders allow-listed media types', () => {
    expect(attachmentKind({ contentType: 'image/png' })).toBe('image');
    expect(attachmentKind({ contentType: 'image/svg+xml', url: 'blob:x' })).toBe('file');
    expect(attachmentKind({ contentType: 'image/svg+xml', url: 'data:image/svg+xml,<svg/>' })).toBe(
      'image',
    );
    expect(attachmentKind({ contentType: 'text/html' })).toBe('file');
    expect(attachmentKind({ contentType: 'video/mp4' })).toBe('video');
  });

  it('reserves an aspect-correct box before load', () => {
    expect(fitMedia({ width: 1600, height: 800 })).toEqual({ width: 400, height: 200 });
    expect(fitMedia({ width: 100, height: 50 })).toEqual({ width: 100, height: 50 });
    expect(fitMedia({ width: 600, height: 1200 })).toEqual({ width: 160, height: 320 });
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
  });
});

describe('classifyAttachmentFailure', () => {
  it('reads kind and message off a duck-typed SignalCliError-shaped object', () => {
    expect(classifyAttachmentFailure({ kind: 'timeout', message: 'too slow' })).toBe('timeout');
    expect(classifyAttachmentFailure({ kind: 'too-large', message: 'nope' })).toBe('too-large');
    expect(
      classifyAttachmentFailure({ kind: 'user', message: 'Could not find attachment with ID: x' }),
    ).toBe('missing-on-disk');
    expect(
      classifyAttachmentFailure({
        kind: 'user',
        message: 'Attachment is no longer available on the server: x',
      }),
    ).toBe('expired');
    expect(
      classifyAttachmentFailure({ kind: 'io', message: 'Attachment is no longer available: x' }),
    ).toBe('expired');
    expect(classifyAttachmentFailure({ kind: 'io', message: 'disk full' })).toBe('download-failed');
    expect(classifyAttachmentFailure({ kind: 'internal', code: -32603, message: 'boom' })).toBe(
      'rpc-error:-32603',
    );
  });

  it('never needs the message to classify a code-only or plain error', () => {
    expect(classifyAttachmentFailure({ code: -3 })).toBe('rpc-error:-3');
    expect(classifyAttachmentFailure(new Error('Download failed'))).toBe('download-failed');
    expect(classifyAttachmentFailure('not even an object')).toBe('download-failed');
    expect(classifyAttachmentFailure(undefined)).toBe('download-failed');
  });
});

describe('attachmentFailureCopy', () => {
  it('shows no Retry for permanent failures', () => {
    expect(attachmentFailureCopy('missing-on-disk').retryable).toBe(false);
    expect(attachmentFailureCopy('expired').retryable).toBe(false);
    expect(attachmentFailureCopy('too-large').retryable).toBe(false);
    expect(attachmentFailureCopy('missing-on-disk').label).toBe('No longer available');
    expect(attachmentFailureCopy('expired').label).toBe('No longer available');
  });

  it('offers Retry for failures another attempt could plausibly fix', () => {
    expect(attachmentFailureCopy('download-failed').retryable).toBe(true);
    expect(attachmentFailureCopy('timeout').retryable).toBe(true);
    expect(attachmentFailureCopy('media-decode').retryable).toBe(true);
    expect(attachmentFailureCopy('rpc-error:-32603').retryable).toBe(true);
  });

  it('gives media-decode its own label, distinct from a download failure', () => {
    expect(attachmentFailureCopy('media-decode').label).toBe("Couldn't display");
    expect(attachmentFailureCopy('download-failed').label).toBe("Couldn't download");
  });
});
