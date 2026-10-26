/**
 * Pure poll transitions and read models, shared by the sync engine, the send
 * pipeline and the mock backend so every layer applies Signal's poll rules
 * the same way.
 */
import type { Message, PollContent, PollVote } from './types';

/** Whether `optionIndexes` is a vote this poll accepts. */
export function isValidPollVote(poll: PollContent, optionIndexes: readonly number[]): boolean {
  if (optionIndexes.length > 1 && !poll.allowMultiple) return false;
  const seen = new Set<number>();
  for (const index of optionIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= poll.options.length) return false;
    if (seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

/** Whether `next` replaces `current` for the same voter: the higher count wins, then the later vote. */
function supersedes(next: PollVote, current: PollVote): boolean {
  return (
    next.voteCount > current.voteCount ||
    (next.voteCount === current.voteCount && next.at > current.at)
  );
}

/** Folds one vote into a vote list; a voter keeps their place in it however often they re-vote. */
function foldVote(votes: readonly PollVote[], vote: PollVote): PollVote[] {
  const current = votes.find((v) => v.voterId === vote.voterId);
  if (!current) return [...votes, vote];
  if (!supersedes(vote, current)) return [...votes];
  return votes.map((v) => (v === current ? vote : v));
}

/**
 * Applies a vote. Votes for a poll that has ended or been deleted, with an
 * option the poll doesn't have, twice for one option, or for several options
 * of a single-choice poll are ignored, like Signal Desktop does. Votes can
 * arrive out of order, so one that is not newer than the voter's current
 * answer is ignored too (see `supersedes`).
 */
export function applyPollVote(message: Message, vote: PollVote): Message {
  const poll = message.poll;
  if (!poll || message.deleted || poll.ended === true) return message;
  if (!isValidPollVote(poll, vote.optionIndexes)) return message;
  const votes = foldVote(poll.votes, vote);
  const same = votes.length === poll.votes.length && votes.every((v, i) => v === poll.votes[i]);
  if (same) return message;
  return { ...message, poll: { ...poll, votes } };
}

/** Puts one voter's answer back exactly as it was (`undefined`: they had none), whatever came since. */
export function restorePollVote(
  message: Message,
  voterId: string,
  previous: PollVote | undefined,
  /** Only undo while this is still the voter's answer, so a newer one isn't clobbered. */
  expected: PollVote,
): Message {
  const poll = message.poll;
  if (!poll) return message;
  const current = poll.votes.find((v) => v.voterId === voterId);
  if (current?.voteCount !== expected.voteCount) return message;
  const votes = previous
    ? poll.votes.map((v) => (v === current ? previous : v))
    : poll.votes.filter((v) => v !== current);
  return { ...message, poll: { ...poll, votes } };
}

/** Ends a poll. Idempotent; a deleted message stays as it is. */
export function applyPollTerminate(message: Message): Message {
  const poll = message.poll;
  if (!poll || message.deleted || poll.ended === true) return message;
  return { ...message, poll: { ...poll, ended: true } };
}

/** Puts a poll's open state back (the end failed to send). */
export function reopenPoll(message: Message): Message {
  const poll = message.poll;
  if (poll?.ended !== true) return message;
  const { ended: _ended, ...rest } = poll;
  return { ...message, poll: rest };
}

/** Two copies of the same poll (a duplicate delivery, a history import): votes and the end both survive. */
export function mergePolls(existing: PollContent, incoming: PollContent): PollContent {
  const votes = incoming.votes.reduce(
    (acc, vote) => (isValidPollVote(existing, vote.optionIndexes) ? foldVote(acc, vote) : acc),
    existing.votes,
  );
  const ended = existing.ended === true || incoming.ended === true;
  const { ended: _ended, ...rest } = existing;
  return { ...rest, votes: [...votes], ...(ended ? { ended: true } : {}) };
}

/** The voter's current answer, if they have voted (possibly retracted: an empty selection). */
export function pollVoteOf(poll: PollContent, voterId: string): PollVote | undefined {
  return poll.votes.find((v) => v.voterId === voterId);
}

/** The vote count to send for the next change of this voter's answer. */
export function nextPollVoteCount(poll: PollContent, voterId: string): number {
  return (pollVoteOf(poll, voterId)?.voteCount ?? 0) + 1;
}

export interface PollOptionTally {
  index: number;
  text: string;
  /** Who chose it, in the order their votes were first seen. */
  voterIds: string[];
}

export interface PollTally {
  options: PollOptionTally[];
  /** Choices made, summed over options (a voter choosing two options counts twice). */
  totalVotes: number;
  /** Voters with at least one choice: the denominator of each option's share. */
  uniqueVoters: number;
  /** Most voters any one option has. */
  topCount: number;
}

export function tallyPoll(poll: PollContent): PollTally {
  const options = poll.options.map((text, index): PollOptionTally => ({
    index,
    text,
    voterIds: [],
  }));
  const voters = new Set<string>();
  let totalVotes = 0;
  for (const vote of poll.votes) {
    for (const index of vote.optionIndexes) {
      const option = options[index];
      if (!option) continue;
      option.voterIds.push(vote.voterId);
      voters.add(vote.voterId);
      totalVotes += 1;
    }
  }
  return {
    options,
    totalVotes,
    uniqueVoters: voters.size,
    topCount: options.reduce((top, o) => Math.max(top, o.voterIds.length), 0),
  };
}

/** Signal Desktop's marker for a poll where only text fits (the chat list, a notification). */
export const POLL_EMOJI = '📊';

/** What a poll quotes as, and the text after `POLL_EMOJI` in the chat list and notifications. */
export function pollPreviewText(poll: Pick<PollContent, 'question'>): string {
  return `Poll: ${poll.question}`;
}

/** The conversation line for an ended poll: "Mira ended the poll: Where to eat?". */
export function pollEndedText(actorName: string, question: string): string {
  return `${actorName} ended the poll: ${question}`;
}
