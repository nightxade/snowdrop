import { describe, expect, it } from 'vitest';
import {
  checkPollDraft,
  clampGraphemes,
  clampUnits,
  editOption,
  emptyPollDraft,
  pollDraftStarted,
  removeOption,
  type PollDraft,
} from './pollDraft';

/** A draft whose option rows hold `texts`, with stable keys 1..n. */
const draftOf = (texts: string[], question = ''): PollDraft => ({
  question,
  allowMultiple: true,
  options: texts.map((text, i) => ({ key: i + 1, text })),
});
const texts = (d: PollDraft) => d.options.map((o) => o.text);

describe('emptyPollDraft', () => {
  it('starts with two blank options, nothing typed, multiple votes allowed', () => {
    const d = emptyPollDraft();
    expect(texts(d)).toEqual(['', '']);
    expect(d.allowMultiple).toBe(true);
    expect(pollDraftStarted(d)).toBe(false);
    expect(new Set(d.options.map((o) => o.key)).size).toBe(2);
  });

  it('counts as started once anything is typed', () => {
    expect(pollDraftStarted({ ...emptyPollDraft(), question: ' ? ' })).toBe(true);
    expect(pollDraftStarted(draftOf(['', 'x']))).toBe(true);
    expect(pollDraftStarted(draftOf(['  ', ' ']))).toBe(false);
  });
});

describe('editOption', () => {
  it('opens a new blank option when the last one gets text', () => {
    const { draft } = editOption(draftOf(['', '']), 2, 'b');
    expect(texts(draft)).toEqual(['', 'b', '']);
  });

  it('stops growing at ten options', () => {
    let d = draftOf(Array.from({ length: 9 }, (_, i) => `o${i}`).concat(['']));
    d = editOption(d, 10, 'last').draft;
    expect(d.options).toHaveLength(10);
    expect(texts(d).at(-1)).toBe('last');
  });

  it('removes an emptied option while more than two remain, keeping a blank one at the end', () => {
    const result = editOption(draftOf(['a', 'b', 'c', '']), 2, '');
    expect(texts(result.draft)).toEqual(['a', 'c', '']);
    expect(result.removed).toBe(1);
    // Never below two.
    const small = editOption(draftOf(['a', '']), 1, '');
    expect(texts(small.draft)).toEqual(['', '']);
    expect(small.removed).toBeUndefined();
  });

  it('puts a blank row back at the end when emptying one of ten full ones', () => {
    const full = draftOf(Array.from({ length: 10 }, (_, i) => `o${i}`));
    const result = editOption(full, 3, '');
    expect(result.draft.options).toHaveLength(10);
    expect(texts(result.draft).at(-1)).toBe('');
    expect(result.removed).toBe(2);
  });

  it('drops a spare blank row when the last one is emptied again', () => {
    const result = editOption(draftOf(['a', '', 'x']), 3, '');
    expect(texts(result.draft)).toEqual(['a', '']);
  });

  it('keeps an option within 100 UTF-16 units, never cutting a character in half', () => {
    const { draft } = editOption(draftOf(['', '']), 1, `${'a'.repeat(99)}😀`);
    expect(draft.options[0]?.text).toBe('a'.repeat(99));
    expect(clampUnits('😀'.repeat(60), 100)).toBe('😀'.repeat(50));
  });

  it('leaves the other options and the question alone', () => {
    const before = draftOf(['a', 'b', ''], 'Q');
    const { draft } = editOption(before, 1, 'z');
    expect(draft.question).toBe('Q');
    expect(texts(draft)).toEqual(['z', 'b', '']);
    expect(before.options[0]?.text).toBe('a');
  });
});

describe('removeOption', () => {
  it('removes a row, keeps two, and keeps a blank to type into', () => {
    const result = removeOption(draftOf(['a', 'b', 'c']), 1);
    expect(texts(result.draft)).toEqual(['b', 'c', '']);
    expect(result.removed).toBe(0);
    const two = removeOption(draftOf(['a', 'b']), 1);
    expect(texts(two.draft)).toEqual(['a', 'b']);
    expect(two.removed).toBeUndefined();
  });
});

describe('clampGraphemes', () => {
  it('cuts to whole characters', () => {
    expect(clampGraphemes('abc', 5)).toBe('abc');
    expect(clampGraphemes('a👨‍👩‍👧b', 2)).toBe('a👨‍👩‍👧');
  });
});

describe('checkPollDraft', () => {
  it('tidies a good poll', () => {
    expect(checkPollDraft(draftOf(['  a ', '', 'b', ''], ' Q? '))).toEqual({
      ok: true,
      poll: { question: 'Q?', options: ['a', 'b'], allowMultiple: true },
    });
  });

  it("names the first problem, in Desktop's order", () => {
    expect(checkPollDraft(draftOf(['a', 'b']))).toEqual({ ok: false, problem: 'question-missing' });
    expect(checkPollDraft(draftOf(['a', ''], 'Q'))).toEqual({
      ok: false,
      problem: 'options-missing',
    });
    expect(checkPollDraft(draftOf([], ''))).toEqual({ ok: false, problem: 'question-missing' });
  });
});
