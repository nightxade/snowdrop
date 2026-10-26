/**
 * The limits Signal puts on a poll a person creates (as Signal Desktop
 * enforces them), and the one check every layer shares: the create dialog
 * for its inline messages, the send pipeline and the signal-cli adapter as
 * last defences.
 */
import { graphemes } from './text';

export const POLL_LIMITS = {
  /** Characters (user-perceived) in the question. */
  questionGraphemes: 100,
  /** Per option, as Signal Desktop counts (and as it accepts them from others). */
  optionGraphemes: 100,
  /**
   * Per option when sending. signal-cli counts UTF-16 code units and
   * refuses an option over the same number, so this stricter count is the
   * one that must hold for what we send.
   */
  optionUnits: 100,
  minOptions: 2,
  maxOptions: 10,
} as const;

export type PollDraftProblem =
  | 'question-missing'
  | 'question-too-long'
  | 'options-missing'
  | 'too-many-options'
  | 'option-too-long';

export interface PollDraftText {
  question: string;
  options: readonly string[];
}

/** Tidies what the person typed: surrounding space trimmed, blank options dropped. */
export function tidyPollDraft<T extends PollDraftText>(draft: T): T & PollDraftText {
  return {
    ...draft,
    question: draft.question.trim(),
    options: draft.options.map((o) => o.trim()).filter((o) => o !== ''),
  };
}

/** What is wrong with an (already tidied) poll, in the order a person would fix it; null when it can be sent. */
export function pollDraftProblem(draft: PollDraftText): PollDraftProblem | null {
  if (draft.question === '') return 'question-missing';
  if (graphemes(draft.question).length > POLL_LIMITS.questionGraphemes) return 'question-too-long';
  if (draft.options.length < POLL_LIMITS.minOptions || draft.options.some((o) => o === ''))
    return 'options-missing';
  if (draft.options.length > POLL_LIMITS.maxOptions) return 'too-many-options';
  if (draft.options.some((o) => o.length > POLL_LIMITS.optionUnits)) return 'option-too-long';
  return null;
}
