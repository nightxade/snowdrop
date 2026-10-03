import { useId, type CSSProperties, type ReactNode } from 'react';
import { initialsFor } from '@/core/domain';
import { TextInput } from '@/ui/primitives';
import { HuePicker } from './HuePicker';
import styles from './SpaceForm.module.css';

export interface SpaceDraft {
  name: string;
  emoji: string;
  hue: number;
}

const EMOJI = ['', '🎯', '🏡', '🧗', '🎮', '🎧', '📚', '🌱', '⚽', '🍳', '✈️', '💼'];

/** Name, emoji and colour fields shared by the create and edit dialogs. */
export function SpaceForm({
  draft,
  onChange,
  onSubmit,
  children,
}: {
  draft: SpaceDraft;
  onChange: (draft: SpaceDraft) => void;
  onSubmit: () => void;
  /** Extra fields (the conversation checklist). */
  children?: ReactNode;
}) {
  const emojiLabel = useId();
  const preview = draft.emoji || initialsFor(draft.name || 'New space');
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className={styles.top}>
        <span
          className={styles.preview}
          style={{ '--tile-hue': `var(--snowdrop-avatar-${draft.hue})` } as CSSProperties}
          aria-hidden
        >
          {preview}
        </span>
        <TextInput
          className={styles.name}
          label="Space name"
          value={draft.name}
          maxLength={40}
          placeholder="e.g. Book club"
          onChange={(e) => {
            onChange({ ...draft, name: e.target.value });
          }}
        />
      </div>
      <div className={styles.group}>
        <span className={styles.label} id={emojiLabel}>
          Icon
        </span>
        <div className={styles.choices} role="radiogroup" aria-labelledby={emojiLabel}>
          {EMOJI.map((emoji) => (
            <button
              key={emoji || 'none'}
              type="button"
              role="radio"
              aria-checked={draft.emoji === emoji}
              aria-label={emoji || 'Initials'}
              className={styles.emoji}
              onClick={() => {
                onChange({ ...draft, emoji });
              }}
            >
              {emoji || <span className={styles.initials}>Aa</span>}
            </button>
          ))}
        </div>
      </div>
      <HuePicker
        value={draft.hue}
        onChange={(hue) => {
          if (hue !== null) onChange({ ...draft, hue });
        }}
      />
      {children}
      {/* Lets Enter in the name field submit. */}
      <button type="submit" hidden />
    </form>
  );
}
