import { useState, type KeyboardEvent } from 'react';
import { formatKeybind, isMacPlatform, parseKeybind } from '@/core/commands';
import { Kbd } from '@/ui/primitives';
import { recordKey } from './record';
import styles from './keybinds.module.css';

export interface KeybindRecorderProps {
  /** Effective binding ("Mod+K"), or null when unbound. */
  value: string | null;
  /** Called with the new binding, or '' to unbind. */
  onRecord: (keybind: string) => void;
  /** Accessible name, e.g. "Shortcut for Open settings". */
  label: string;
  id?: string;
  'aria-describedby'?: string | undefined;
}

/**
 * Click (or Enter) to record, then press the keys. Escape cancels, Backspace
 * clears. The button keeps focus throughout, so keyboard users never lose
 * their place.
 */
export function KeybindRecorder({ value, onRecord, label, id, ...rest }: KeybindRecorderProps) {
  const [recording, setRecording] = useState(false);
  const mac = isMacPlatform();
  const parsed = value ? parseKeybind(value) : null;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const outcome = recordKey(e, mac);
    if (!outcome) return;
    setRecording(false);
    if (outcome.type === 'unbind') onRecord('');
    if (outcome.type === 'set') onRecord(outcome.keybind);
  };

  return (
    <button
      type="button"
      id={id}
      className={styles.recorder}
      data-recording={recording ? '' : undefined}
      data-owns-escape={recording ? '' : undefined}
      aria-label={
        recording
          ? `${label}: press the new shortcut, Escape to cancel, Backspace to clear`
          : `${label}: ${parsed ? formatKeybind(parsed, mac) : 'not set'}. Activate to change.`
      }
      aria-describedby={rest['aria-describedby']}
      onClick={() => {
        setRecording(true);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        setRecording(false);
      }}
    >
      {recording ? (
        <span className={styles.listening} aria-live="polite">
          Press keys…
        </span>
      ) : parsed ? (
        <Kbd combo={formatKeybind(parsed, mac)} />
      ) : (
        <span className={styles.unset}>Not set</span>
      )}
    </button>
  );
}
