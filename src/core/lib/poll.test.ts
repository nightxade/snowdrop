import { describe, expect, it } from 'vitest';
import { pollDraftProblem, POLL_LIMITS, tidyPollDraft } from './poll';

const valid = { question: 'Where to eat?', options: ['Pizza', 'Ramen'] };

describe('pollDraftProblem', () => {
  it('accepts a question with two to ten options', () => {
    expect(pollDraftProblem(valid)).toBeNull();
    expect(
      pollDraftProblem({ ...valid, options: Array.from({ length: 10 }, (_, i) => `o${i}`) }),
    ).toBeNull();
  });

  it('asks for a question first, then the options', () => {
    expect(pollDraftProblem({ question: '', options: [] })).toBe('question-missing');
    expect(pollDraftProblem({ ...valid, options: ['Pizza'] })).toBe('options-missing');
    expect(pollDraftProblem({ ...valid, options: ['Pizza', ''] })).toBe('options-missing');
  });

  it('refuses more than ten options', () => {
    expect(
      pollDraftProblem({ ...valid, options: Array.from({ length: 11 }, (_, i) => `o${i}`) }),
    ).toBe('too-many-options');
  });

  it('counts a question in whole characters and an option in UTF-16 units', () => {
    // 100 family emoji are 100 characters (and far more than 100 units): fine for a question.
    const family = '👨‍👩‍👧';
    expect(pollDraftProblem({ ...valid, question: family.repeat(100) })).toBeNull();
    expect(pollDraftProblem({ ...valid, question: family.repeat(101) })).toBe('question-too-long');
    expect(pollDraftProblem({ ...valid, options: ['a'.repeat(100), 'b'] })).toBeNull();
    expect(pollDraftProblem({ ...valid, options: ['a'.repeat(101), 'b'] })).toBe('option-too-long');
    // 51 emoji are 102 units: over what signal-cli accepts, though only 51 characters.
    expect(pollDraftProblem({ ...valid, options: ['😀'.repeat(51), 'b'] })).toBe('option-too-long');
    expect(POLL_LIMITS.optionUnits).toBe(100);
  });
});

describe('tidyPollDraft', () => {
  it('trims the question and drops blank options', () => {
    expect(
      tidyPollDraft({
        question: '  Lunch?  ',
        options: [' a ', '', '   ', 'b'],
        allowMultiple: false,
      }),
    ).toEqual({ question: 'Lunch?', options: ['a', 'b'], allowMultiple: false });
  });
});
