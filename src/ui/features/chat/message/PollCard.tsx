import { Check, Star } from 'lucide-react';
import { useId, useState } from 'react';
import { useStore } from 'zustand';
import { initialsFor, pollVoteOf, tallyPoll, type PollContent } from '@/core/domain';
import { contactsSelectors, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { Avatar, Button, Modal, VisuallyHidden } from '@/ui/primitives';
import styles from './PollCard.module.css';

/**
 * How the card relates to the poll: `vote` lets the user answer it, `pending`
 * shows the options of a poll that hasn't gone out yet (nothing to answer
 * until it exists for everyone), `view` only shows it (ended, or not the
 * user's to answer: a message request, or a backend that can't take votes).
 */
export type PollCardMode = 'vote' | 'pending' | 'view';

export interface PollCardProps {
  poll: PollContent;
  mode: PollCardMode;
  selfId: string | null;
  /** Sets our whole answer: every option now chosen (empty retracts). */
  onVote: (optionIndexes: number[]) => Promise<void>;
  /** Id for the question, which the row's aria-describedby points at (it has no body text). */
  id?: string | undefined;
  /** Opens "Poll details" (`PollVotesDialog`), which the row renders outside itself. */
  onViewVotes: () => void;
}

function statusLine(poll: PollContent): string {
  if (poll.ended === true) return 'Poll · Final results';
  return poll.allowMultiple ? 'Poll · Select one or more' : 'Poll · Select one';
}

const votesLabel = (count: number): string => `${count} ${count === 1 ? 'vote' : 'votes'}`;

/** Share of the people who voted that chose this option, in whole percent. */
function share(count: number, voters: number): number {
  return voters > 0 ? Math.round((count / voters) * 100) : 0;
}

/**
 * A poll in a message row: the question, one row per option with its vote
 * count and a bar for its share, and — while it is open — a checkbox per
 * option to answer it. Single-choice polls use the same checkboxes, as Signal
 * Desktop does: choosing another option moves your vote, and clearing it
 * retracts it. "View votes" opens who chose what.
 *
 * Votes show at once (the caller applies them optimistically); while one is
 * on its way the options ignore further changes rather than lose keyboard
 * focus to a disabled control.
 */
export function PollCard({ poll, mode, selfId, onVote, onViewVotes, id }: PollCardProps) {
  const ownId = useId();
  const questionId = id ?? ownId;
  const statusId = useId();
  const [busy, setBusy] = useState(false);
  const tally = tallyPoll(poll);
  const mine = new Set(selfId === null ? [] : (pollVoteOf(poll, selfId)?.optionIndexes ?? []));
  const ended = poll.ended === true;
  const answerable = !ended && mode !== 'view';

  const toggle = (index: number, checked: boolean) => {
    if (busy || mode !== 'vote') return;
    // Single choice: choosing replaces the old answer.
    const next = new Set(poll.allowMultiple ? mine : []);
    if (checked) next.add(index);
    else next.delete(index);
    setBusy(true);
    void onVote([...next].sort((a, b) => a - b)).finally(() => {
      setBusy(false);
    });
  };

  return (
    <div
      className={styles.card}
      role="group"
      aria-labelledby={questionId}
      aria-describedby={statusId}
      aria-busy={busy || undefined}
      data-snowdrop="poll"
      data-ended={ended ? '' : undefined}
    >
      <p className={styles.question} id={questionId}>
        {poll.question}
      </p>
      <p className={styles.status} id={statusId}>
        {statusLine(poll)}
      </p>
      <ul className={styles.options}>
        {tally.options.map((option) => {
          const count = option.voterIds.length;
          const chosen = mine.has(option.index);
          const percent = share(count, tally.uniqueVoters);
          const body = (
            <span className={styles.body}>
              <span className={styles.line}>
                <span className={styles.text}>{option.text}</span>
                <span className={styles.count}>
                  {chosen && !answerable && (
                    <span className={styles.voted}>
                      <Check size={12} strokeWidth={3} aria-hidden />
                      <VisuallyHidden>You voted. </VisuallyHidden>
                    </span>
                  )}
                  <span aria-hidden>{count}</span>
                  <VisuallyHidden>{`${votesLabel(count)}, ${percent}%`}</VisuallyHidden>
                </span>
              </span>
              <span className={styles.track} aria-hidden>
                <span className={styles.fill} style={{ width: `${percent}%` }} />
              </span>
            </span>
          );
          return (
            <li key={option.index} className={styles.option} data-chosen={chosen ? '' : undefined}>
              {answerable ? (
                <label className={styles.choice}>
                  <span className={styles.box}>
                    <input
                      type="checkbox"
                      className={styles.input}
                      checked={chosen}
                      aria-disabled={mode !== 'vote' || busy || undefined}
                      onChange={(e) => {
                        toggle(option.index, e.target.checked);
                      }}
                    />
                    <Check className={styles.mark} size={14} strokeWidth={3} aria-hidden />
                  </span>
                  {body}
                </label>
              ) : (
                <div className={styles.choice}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <div className={styles.footer}>
        {tally.totalVotes > 0 ? (
          <Button size="sm" variant="secondary" onClick={onViewVotes}>
            View votes
          </Button>
        ) : (
          <p className={styles.none}>No votes</p>
        )}
      </div>
    </div>
  );
}

/**
 * "Poll details": the question, then each option with the people who chose
 * it. The author of an open poll can end it from here (`onEnd`, which the
 * caller confirms).
 */
export function PollVotesDialog({
  poll,
  onEnd,
  onOpenChange,
}: {
  poll: PollContent;
  onEnd: (() => void) | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const tally = tallyPoll(poll);
  const stores = useStores();
  const byId = useStore(stores.contacts, contactsSelectors.byId);
  const selfId = useStore(stores.session, (s) => s.self?.id ?? null);
  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title="Poll details"
      size="sm"
      footer={
        poll.ended !== true && onEnd ? (
          <Button variant="danger" onClick={onEnd}>
            End poll
          </Button>
        ) : undefined
      }
    >
      <p className={styles.detailsQuestion}>{poll.question}</p>
      {tally.options.map((option) => {
        const count = option.voterIds.length;
        const top = count > 0 && count === tally.topCount;
        return (
          <section key={option.index} className={styles.detailsOption}>
            <h3 className={styles.detailsHeading}>
              <span className={styles.detailsText}>{option.text}</span>
              {count > 0 && (
                <span className={styles.detailsMeta}>
                  {top && (
                    <span className={styles.top}>
                      <Star size={12} fill="currentColor" aria-hidden />
                      <VisuallyHidden>Winning, </VisuallyHidden>
                    </span>
                  )}
                  {votesLabel(count)}
                </span>
              )}
            </h3>
            {count === 0 ? (
              <p className={styles.none}>No votes</p>
            ) : (
              <ul className={styles.voters}>
                {option.voterIds.map((id) => {
                  const contact = byId[id];
                  const name = id === selfId ? 'You' : (contact?.name ?? UNKNOWN_CONTACT_NAME);
                  // Your own avatar is the one you have; only the name says "You".
                  const initials = initialsFor(contact?.name ?? name);
                  return (
                    <li key={id} className={styles.voter}>
                      <Avatar
                        {...(contact?.avatarUrl ? { src: contact.avatarUrl } : {})}
                        fallback={initials}
                        color={contact?.color ?? 'var(--snowdrop-avatar-1)'}
                        size={32}
                      />
                      <span className={styles.voterName}>{name}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </Modal>
  );
}
