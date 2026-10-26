import { describe, expect, it } from 'vitest';
import { applyDelete, mergeDuplicate } from './messageOps';
import {
  applyPollTerminate,
  applyPollVote,
  isValidPollVote,
  mergePolls,
  nextPollVoteCount,
  pollPreviewText,
  pollVoteOf,
  reopenPoll,
  restorePollVote,
  tallyPoll,
} from './poll';
import { makeMessage } from './testing';
import type { Message, PollContent, PollVote } from './types';

const poll = (extra: Partial<PollContent> = {}): Message =>
  makeMessage({
    authorId: 'me',
    sentAt: 10,
    poll: {
      question: 'Where to eat?',
      options: ['Pizza', 'Ramen', 'Tacos'],
      allowMultiple: true,
      votes: [],
      ...extra,
    },
  });

const vote = (voterId: string, optionIndexes: number[], voteCount = 1, at = 100): PollVote => ({
  voterId,
  optionIndexes,
  voteCount,
  at,
});

describe('applyPollVote', () => {
  it('records a vote, and keeps each voter in the place they first voted', () => {
    let m = applyPollVote(poll(), vote('ana', [0]));
    m = applyPollVote(m, vote('bo', [1]));
    m = applyPollVote(m, vote('ana', [2], 2));
    expect(m.poll?.votes.map((v) => [v.voterId, v.optionIndexes])).toEqual([
      ['ana', [2]],
      ['bo', [1]],
    ]);
  });

  it('lets the highest voteCount win, whatever order the votes arrive in', () => {
    const newest = applyPollVote(poll(), vote('ana', [1], 3));
    const late = applyPollVote(newest, vote('ana', [0], 2));
    expect(late).toBe(newest);
    expect(pollVoteOf(late.poll!, 'ana')?.optionIndexes).toEqual([1]);
    const older = applyPollVote(poll(), vote('ana', [0], 2));
    expect(
      pollVoteOf(applyPollVote(older, vote('ana', [1], 3)).poll!, 'ana')?.optionIndexes,
    ).toEqual([1]);
  });

  it('breaks a tie on voteCount by the later vote, and ignores an exact repeat', () => {
    const first = applyPollVote(poll(), vote('ana', [0], 2, 100));
    const later = applyPollVote(first, vote('ana', [1], 2, 200));
    expect(pollVoteOf(later.poll!, 'ana')?.optionIndexes).toEqual([1]);
    expect(applyPollVote(later, vote('ana', [1], 2, 200))).toBe(later);
    expect(applyPollVote(later, vote('ana', [0], 2, 150))).toBe(later);
  });

  it('retracts a vote with an empty selection, which stays on record as the newest answer', () => {
    const voted = applyPollVote(poll(), vote('ana', [0], 1));
    const retracted = applyPollVote(voted, vote('ana', [], 2));
    expect(retracted.poll?.votes).toEqual([vote('ana', [], 2)]);
    expect(applyPollVote(retracted, vote('ana', [0], 1))).toBe(retracted);
  });

  it('allows several options only on a multiple-choice poll', () => {
    expect(applyPollVote(poll(), vote('ana', [0, 2])).poll?.votes).toHaveLength(1);
    const single = poll({ allowMultiple: false });
    expect(applyPollVote(single, vote('ana', [0, 2]))).toBe(single);
    expect(applyPollVote(single, vote('ana', [2])).poll?.votes).toHaveLength(1);
  });

  it('drops options the poll does not have and options chosen twice', () => {
    const m = poll();
    expect(applyPollVote(m, vote('ana', [3]))).toBe(m);
    expect(applyPollVote(m, vote('ana', [-1]))).toBe(m);
    expect(applyPollVote(m, vote('ana', [1, 1]))).toBe(m);
    expect(applyPollVote(m, vote('ana', [1.5]))).toBe(m);
    expect(isValidPollVote(m.poll!, [0, 1, 2])).toBe(true);
  });

  it('ignores votes on an ended or deleted poll, or on a message that is not one', () => {
    const ended = poll({ ended: true });
    expect(applyPollVote(ended, vote('ana', [0]))).toBe(ended);
    const deleted = { ...poll(), deleted: true };
    expect(applyPollVote(deleted, vote('ana', [0]))).toBe(deleted);
    const plain = makeMessage({ body: 'hi' });
    expect(applyPollVote(plain, vote('ana', [0]))).toBe(plain);
  });

  it('does not change the message it was given', () => {
    const m = poll();
    const before = structuredClone(m);
    applyPollVote(m, vote('ana', [0]));
    expect(m).toEqual(before);
  });
});

describe('ending a poll', () => {
  it('ends it once, and stops it taking votes', () => {
    const ended = applyPollTerminate(poll());
    expect(ended.poll?.ended).toBe(true);
    expect(applyPollTerminate(ended)).toBe(ended);
    expect(applyPollVote(ended, vote('ana', [0]))).toBe(ended);
  });

  it('can be put back to open (a failed end)', () => {
    const open = poll();
    const reopened = reopenPoll(applyPollTerminate(open));
    expect(reopened.poll).toEqual(open.poll);
    expect('ended' in reopened.poll!).toBe(false);
    expect(reopenPoll(open)).toBe(open);
  });

  it('leaves a deleted poll alone', () => {
    const deleted = { ...poll(), deleted: true };
    expect(applyPollTerminate(deleted)).toBe(deleted);
  });
});

describe('restorePollVote', () => {
  it('puts the previous answer back, or removes the first one', () => {
    const before = vote('me', [0], 1);
    const mine = vote('me', [1], 2);
    const voted = applyPollVote(poll({ votes: [before] }), mine);
    expect(restorePollVote(voted, 'me', before, mine).poll?.votes).toEqual([before]);
    const first = applyPollVote(poll(), mine);
    expect(restorePollVote(first, 'me', undefined, mine).poll?.votes).toEqual([]);
  });

  it('does not undo a newer answer', () => {
    const mine = vote('me', [1], 2);
    const newer = applyPollVote(applyPollVote(poll(), mine), vote('me', [2], 3));
    expect(restorePollVote(newer, 'me', undefined, mine)).toBe(newer);
  });
});

describe('vote counts and tallies', () => {
  it('numbers our next vote one past our latest, from 1', () => {
    expect(nextPollVoteCount(poll().poll!, 'me')).toBe(1);
    expect(nextPollVoteCount(poll({ votes: [vote('me', [], 4)] }).poll!, 'me')).toBe(5);
    expect(nextPollVoteCount(poll({ votes: [vote('ana', [0], 9)] }).poll!, 'me')).toBe(1);
  });

  it('counts choices, voters and the leading option', () => {
    const t = tallyPoll(
      poll({
        votes: [vote('ana', [0, 1]), vote('bo', [1]), vote('cy', []), vote('di', [1, 2])],
      }).poll!,
    );
    expect(t.options.map((o) => o.voterIds)).toEqual([['ana'], ['ana', 'bo', 'di'], ['di']]);
    expect(t.totalVotes).toBe(5);
    expect(t.uniqueVoters).toBe(3);
    expect(t.topCount).toBe(3);
  });

  it('is empty for a poll nobody has voted on', () => {
    const t = tallyPoll(poll().poll!);
    expect([t.totalVotes, t.uniqueVoters, t.topCount]).toEqual([0, 0, 0]);
  });

  it('previews as "Poll: question"', () => {
    expect(pollPreviewText({ question: 'Where to eat?' })).toBe('Poll: Where to eat?');
  });
});

describe('merging copies of a poll', () => {
  it('keeps votes and the end from both copies', () => {
    const a = poll({ votes: [vote('ana', [0], 1)] });
    const b = poll({ votes: [vote('ana', [1], 2), vote('bo', [2])], ended: true });
    const merged = mergeDuplicate(a, b);
    expect(merged.poll?.ended).toBe(true);
    expect(merged.poll?.votes.map((v) => [v.voterId, v.optionIndexes])).toEqual([
      ['ana', [1]],
      ['bo', [2]],
    ]);
    expect(
      mergePolls(b.poll!, a.poll!).votes.find((v) => v.voterId === 'ana')?.optionIndexes,
    ).toEqual([1]);
  });

  it('never brings a poll back to a message that was deleted', () => {
    const deleted = applyDelete(poll({ votes: [vote('ana', [0])] }));
    expect(deleted.poll).toBeUndefined();
    expect(mergeDuplicate(deleted, poll()).poll).toBeUndefined();
  });
});
