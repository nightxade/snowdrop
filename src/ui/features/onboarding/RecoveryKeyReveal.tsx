/**
 * The recovery key itself, once created: the grouped code, Copy/Save
 * buttons, and the "type the last group to confirm" step
 * (docs/ENCRYPTION.md, "Recovery slot"). Shared by `StorageSetup` (first
 * run) and Settings → Privacy & security (create/replace) — the caller owns
 * the surrounding heading and lede, since those differ by context; this is
 * only the part that was previously duplicated.
 */
import { Copy, Save } from 'lucide-react';
import { useState } from 'react';
import { Button, TextInput } from '@/ui/primitives';
import { groupRecoveryCode } from './storageCopy';
import styles from './Storage.module.css';

export interface RecoveryKeyRevealProps {
  /** The plaintext code, shown once. Never log it. */
  code: string;
  /** The last group matched what was typed. */
  onConfirmed: () => void;
}

export function downloadRecoveryKey(code: string): void {
  const url = URL.createObjectURL(new Blob([`${code}\n`], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'snowdrop-recovery-key.txt';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export function RecoveryKeyReveal({ code, onConfirmed }: RecoveryKeyRevealProps) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const groups = groupRecoveryCode(code);
  const lastGroup = groups[groups.length - 1] ?? '';
  const grouped = groups.join('-');

  return (
    <>
      <div className={styles.recoveryCode} role="group" aria-label="Recovery key">
        {groups.map((group, i) => (
          <span
            key={i}
            className={styles.recoveryGroup}
            data-checksum={i === groups.length - 1 ? '' : undefined}
          >
            {group}
          </span>
        ))}
      </div>
      <div className={styles.recoveryActions}>
        <Button
          type="button"
          icon={<Copy size={16} />}
          onClick={() => {
            void navigator.clipboard.writeText(grouped);
          }}
        >
          Copy
        </Button>
        <Button
          type="button"
          icon={<Save size={16} />}
          onClick={() => {
            downloadRecoveryKey(grouped);
          }}
        >
          Save as file…
        </Button>
      </div>
      <form
        className={styles.confirmRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm.trim().toUpperCase() !== lastGroup) {
            setError("That doesn't match the last group.");
            return;
          }
          onConfirmed();
        }}
      >
        <TextInput
          label="Type the last group to confirm"
          placeholder={lastGroup}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={confirm}
          error={error ?? undefined}
          onChange={(e) => {
            setConfirm(e.target.value);
            setError(null);
          }}
        />
        <Button type="submit" variant="primary">
          Confirm
        </Button>
      </form>
    </>
  );
}
