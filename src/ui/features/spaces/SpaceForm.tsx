import { useId, type CSSProperties } from 'react';
import { initialsFor } from '@/core/domain';
import { TextInput } from '@/ui/primitives';
import styles from './SpaceForm.module.css';

export interface SpaceDraft {
  name: string;
  emoji: string;
  hue: number;
}

const EMOJI = ['', '🎯', '🏡', '🧗', '🎮', '🎧', '📚', '🌱', '⚽', '🍳', '✈️', '💼'];
const HUES = Array.from({ length: 12 }, (_, i) => i + 1);

/** Name, emoji and colour fields shared by the create and edit dialogs. */
export function SpaceForm({
  draft,
  onChange,
  onSubmit,
}: {
  draft: SpaceDraft;
  onChange: (draft: SpaceDraft) => void;
  onSubmit: () => void;
}) {
  const emojiLabel = useId();
  const hueLabel = useId();
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
          style={{ '--tile-hue': `var(--shrike-avatar-${draft.hue})` } as CSSProperties}
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
      <div className={styles.group}>
        <span className={styles.label} id={hueLabel}>
          Colour
        </span>
        <div
          className={styles.choices}
          data-kind="hue"
          role="radiogroup"
          aria-labelledby={hueLabel}
        >
          {HUES.map((hue) => (
            <button
              key={hue}
              type="button"
              role="radio"
              aria-checked={draft.hue === hue}
              aria-label={`Colour ${hue}`}
              className={styles.swatch}
              style={{ '--tile-hue': `var(--shrike-avatar-${hue})` } as CSSProperties}
              onClick={() => {
                onChange({ ...draft, hue });
              }}
            />
          ))}
        </div>
      </div>
      {/* Lets Enter in the name field submit. */}
      <button type="submit" hidden />
    </form>
  );
}
