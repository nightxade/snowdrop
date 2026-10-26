import { describe, expect, it } from 'vitest';
import { coverCrop } from '@/ui/lib/avatarImage';
import { fieldCounter, fitField, normalizeDraft, sameDraft } from './profileFields';

describe('fitField', () => {
  it('keeps a name within 26 characters and 128 bytes', () => {
    expect(fitField('x'.repeat(40), 'name')).toHaveLength(26);
    expect(fitField('🙂'.repeat(40), 'name')).toBe('🙂'.repeat(26));
    // A family emoji is one character but 25 bytes, so the byte limit bites first.
    expect(fitField('👨‍👩‍👧‍👦'.repeat(10), 'name')).toBe('👨‍👩‍👧‍👦'.repeat(5));
  });

  it('keeps about text within 140 characters and 512 bytes', () => {
    expect(fitField('x'.repeat(200), 'about')).toHaveLength(140);
    expect(fitField('🙂'.repeat(140), 'about')).toBe('🙂'.repeat(128));
  });
});

describe('fieldCounter', () => {
  it('stays hidden until half of the room is used, then warns in the last quarter', () => {
    expect(fieldCounter('', 'name').visible).toBe(false);
    expect(fieldCounter('x'.repeat(10), 'name')).toMatchObject({ remaining: 16, visible: false });
    expect(fieldCounter('x'.repeat(13), 'name')).toMatchObject({
      remaining: 13,
      visible: true,
      warn: false,
    });
    expect(fieldCounter('x'.repeat(20), 'name')).toMatchObject({
      remaining: 6,
      visible: true,
      warn: true,
    });
  });

  it('counts the tighter of characters and bytes', () => {
    // 100 emoji: 40 characters left but 112 bytes, so characters are tighter.
    expect(fieldCounter('🙂'.repeat(100), 'about').remaining).toBe(40);
    // 125 emoji: 15 characters left but only 12 bytes.
    expect(fieldCounter('🙂'.repeat(125), 'about').remaining).toBe(12);
    expect(fieldCounter('🙂'.repeat(128), 'about').remaining).toBe(0);
  });
});

describe('normalizeDraft and sameDraft', () => {
  const draft = { givenName: ' Ada ', familyName: '', about: ' hi ', aboutEmoji: '🙂' };

  it('trims, and drops the emoji when there is no about text', () => {
    expect(normalizeDraft(draft)).toEqual({
      givenName: 'Ada',
      familyName: '',
      about: 'hi',
      aboutEmoji: '🙂',
    });
    expect(normalizeDraft({ ...draft, about: '  ' }).aboutEmoji).toBe('');
  });

  it('ignores surrounding whitespace when comparing', () => {
    expect(sameDraft(draft, { ...draft, givenName: 'Ada', about: 'hi' })).toBe(true);
    expect(sameDraft(draft, { ...draft, familyName: 'L' })).toBe(false);
  });
});

describe('coverCrop', () => {
  it('takes the centred square and shrinks it to at most 512', () => {
    expect(coverCrop(1000, 600)).toEqual({ sx: 200, sy: 0, side: 600, out: 512 });
    expect(coverCrop(300, 400)).toEqual({ sx: 0, sy: 50, side: 300, out: 300 });
    expect(coverCrop(512, 512)).toEqual({ sx: 0, sy: 0, side: 512, out: 512 });
  });
});
