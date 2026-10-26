/**
 * The create-poll dialog's model: the draft being typed, how it grows and
 * shrinks as options are typed (Signal Desktop's behaviour: there is always
 * one blank option to type into, up to ten), and what stops it being sent.
 */
import {
  graphemes,
  pollDraftProblem,
  POLL_LIMITS,
  tidyPollDraft,
  type PollDraftProblem,
} from '@/core/lib';

export interface PollDraft {
  question: string;
  /** Every option row, blank ones included; each has a stable key for focus and rendering. */
  options: { key: number; text: string }[];
  allowMultiple: boolean;
}

let nextKey = 0;
const blank = () => ({ key: ++nextKey, text: '' });

export function emptyPollDraft(): PollDraft {
  return {
    question: '',
    options: Array.from({ length: POLL_LIMITS.minOptions }, blank),
    allowMultiple: true,
  };
}

/** Anything typed at all (Send stays off until then). */
export function pollDraftStarted(draft: PollDraft): boolean {
  return draft.question.trim() !== '' || draft.options.some((o) => o.text.trim() !== '');
}

/** Cuts text to at most `max` user-perceived characters, never through one. */
export function clampGraphemes(text: string, max: number): string {
  const parts = graphemes(text);
  return parts.length <= max ? text : parts.slice(0, max).join('');
}

/** Cuts text to at most `max` UTF-16 code units (what signal-cli counts), never through a character. */
export function clampUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const g of graphemes(text)) {
    if (out.length + g.length > max) break;
    out += g;
  }
  return out;
}

/**
 * Changes one option's text and keeps the list tidy, as Signal Desktop does:
 * typing in the last row opens a new blank one (up to the maximum), and
 * emptying a row removes it while more than the minimum remain — a blank row
 * stays at the end. `removed` is the index that disappeared, so focus can
 * land on the row that took its place.
 */
export function editOption(
  draft: PollDraft,
  key: number,
  text: string,
): { draft: PollDraft; removed?: number } {
  let options = draft.options.map((o) =>
    o.key === key ? { ...o, text: clampUnits(text, POLL_LIMITS.optionUnits) } : o,
  );
  const index = options.findIndex((o) => o.key === key);
  const filled = (options[index]?.text.trim() ?? '') !== '';
  const last = index === options.length - 1;
  let removed: number | undefined;
  if (last && filled && options.length < POLL_LIMITS.maxOptions) options = [...options, blank()];
  else if (!last && !filled && options.length > POLL_LIMITS.minOptions) {
    options = options.filter((o) => o.key !== key);
    removed = index;
    // Always leave a blank row to type into.
    if (options.at(-1)?.text.trim() !== '' && options.length < POLL_LIMITS.maxOptions)
      options = [...options, blank()];
  } else if (last && !filled && options.length > POLL_LIMITS.minOptions) {
    // Emptied the last row: the blank one before it is enough.
    const before = options.at(-2);
    if (before && before.text.trim() === '') {
      options = options.slice(0, -1);
      removed = options.length;
    }
  }
  return { draft: { ...draft, options }, ...(removed === undefined ? {} : { removed }) };
}

/** Removes one option row (its own button), keeping a blank row at the end and the minimum. */
export function removeOption(
  draft: PollDraft,
  key: number,
): { draft: PollDraft; removed?: number } {
  const index = draft.options.findIndex((o) => o.key === key);
  if (index === -1 || draft.options.length <= POLL_LIMITS.minOptions) return { draft };
  let options = draft.options.filter((o) => o.key !== key);
  if (options.at(-1)?.text.trim() !== '' && options.length < POLL_LIMITS.maxOptions)
    options = [...options, blank()];
  return { draft: { ...draft, options }, removed: index };
}

export const POLL_PROBLEM_TEXT: Record<PollDraftProblem, string> = {
  'question-missing': 'Poll question is required',
  'question-too-long': 'Question is too long',
  'options-missing': 'Poll requires at least 2 options',
  'too-many-options': 'Poll can have at most 10 options',
  'option-too-long': 'Option is too long',
};

/** The poll to send and nothing wrong with it, or the first thing to fix. */
export function checkPollDraft(
  draft: PollDraft,
):
  | { ok: true; poll: { question: string; options: string[]; allowMultiple: boolean } }
  | { ok: false; problem: PollDraftProblem } {
  const tidy = tidyPollDraft({
    question: draft.question,
    options: draft.options.map((o) => o.text),
  });
  const problem = pollDraftProblem(tidy);
  if (problem) return { ok: false, problem };
  return {
    ok: true,
    poll: { question: tidy.question, options: tidy.options, allowMultiple: draft.allowMultiple },
  };
}
