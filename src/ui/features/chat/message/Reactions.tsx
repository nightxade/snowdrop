import { SmilePlus } from 'lucide-react';
import { memo, useState } from 'react';
import { summarizeReactions, type Reaction } from '@/core/domain';
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
  if (pills.length === 0) return null;
  return (
    <div className={styles.reactions} role="group" aria-label="Reactions">
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
