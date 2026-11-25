import { SmilePlus } from 'lucide-react';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { summarizeReactions, type Reaction } from '@/core/domain';
import { useHandOffRow } from '@/ui/hooks';
import { EmojiPickerPopover, Tooltip } from '@/ui/primitives';
import styles from './Reactions.module.css';

export interface ReactionsProps {
  reactions: readonly Reaction[];
  selfId: string | null;
  nameFor: (id: string) => string;
  onToggle: (emoji: string) => void;
  onAdd: (emoji: string) => void;
}

/** "Mira", "Mira and Sam", "Mira, Sam and 3 others" — you come first. */
export function reactorsLabel(
  authorIds: readonly string[],
  selfId: string | null,
  nameFor: (id: string) => string,
): string {
  const names = [...authorIds]
    .sort((a, b) => Number(b === selfId) - Number(a === selfId))
    .map((id) => (id === selfId ? 'You' : nameFor(id)));
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0] ?? ''}, ${names[1] ?? ''} and ${names[2] ?? ''}`;
  return `${names[0] ?? ''}, ${names[1] ?? ''} and ${names.length - 2} others`;
}

export const Reactions = memo(function Reactions({
  reactions,
  selfId,
  nameFor,
  onToggle,
  onAdd,
}: ReactionsProps) {
  const [picking, setPicking] = useState(false);
  const pills = summarizeReactions(reactions);
  const group = useRef<HTMLDivElement>(null);
  /** The message row the pills belong to, kept for when the last pill (and the group) goes. */
  const row = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (group.current)
      row.current = group.current.closest<HTMLElement>('[data-snowdrop="message"]');
  });
  // A focused pill that goes (your only reaction removed, someone else's withdrawn) hands focus to
  // the next pill, else the previous, else the message row (M15).
  useHandOffRow({
    ids: pills.map((pill) => pill.emoji),
    identify: (el) => {
      const pill = el.closest<HTMLElement>('[data-reaction]');
      return pill && group.current?.contains(pill) ? (pill.dataset.reaction ?? null) : null;
    },
    find: (emoji) =>
      [...(group.current?.querySelectorAll<HTMLElement>('[data-reaction]') ?? [])].find(
        (el) => el.dataset.reaction === emoji,
      ),
    tabStop: () => row.current,
  });
  if (pills.length === 0) return null;
  return (
    <div ref={group} className={styles.reactions} role="group" aria-label="Reactions">
      {pills.map((pill) => {
        const mine = selfId !== null && pill.authorIds.includes(selfId);
        const who = reactorsLabel(pill.authorIds, selfId, nameFor);
        return (
          <Tooltip
            key={pill.emoji}
            label={
              <span className={styles.tip}>
                <span className={styles.tipEmoji}>{pill.emoji}</span>
                <span>{who} reacted</span>
              </span>
            }
            delayMs={250}
          >
            <button
              type="button"
              className={styles.pill}
              data-reaction={pill.emoji}
              data-mine={mine ? '' : undefined}
              aria-pressed={mine}
              aria-label={`${pill.emoji} ${pill.authorIds.length}: ${who}. ${mine ? 'Remove your reaction' : 'React with this'}`}
              onClick={() => {
                onToggle(pill.emoji);
              }}
            >
              <span className={styles.emoji}>{pill.emoji}</span>
              <span className={styles.count}>{pill.authorIds.length}</span>
            </button>
          </Tooltip>
        );
      })}
      <EmojiPickerPopover
        open={picking}
        onOpenChange={setPicking}
        onSelect={onAdd}
        side="top"
        align="start"
      >
        <button
          type="button"
          className={styles.add}
          aria-label="Add reaction"
          data-open={picking ? '' : undefined}
        >
          <SmilePlus size={16} aria-hidden />
        </button>
      </EmojiPickerPopover>
    </div>
  );
});
