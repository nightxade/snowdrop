/**
 * Settings → Data & storage → Export history: what the user is told and asked
 * before a history file is written. The file holds every stored message, so
 * the dialog says that plainly first, and (on the desktop, where the Rust
 * crypto is available) defaults to encrypting it under a passphrase.
 *
 * The passphrase lives only in this component's state: it's handed to
 * `onConfirm` once and cleared on every way out.
 */
import { useState } from 'react';
import { PassphraseStrengthHint } from '@/ui/features/onboarding';
import { Button, Modal, Segmented, TextInput } from '@/ui/primitives';
import styles from './pages.module.css';

export const EXPORT_PASSPHRASE_MIN = 8;

export type ExportChoice = { encrypt: true; passphrase: string } | { encrypt: false };

type Mode = 'encrypted' | 'plain';

export function ExportHistoryDialog({
  canEncrypt,
  onCancel,
  onConfirm,
}: {
  /** True when the desktop's Rust crypto is available (`app.storageAdmin`). */
  canEncrypt: boolean;
  onCancel: () => void;
  onConfirm: (choice: ExportChoice) => void;
}) {
  const [mode, setMode] = useState<Mode>(canEncrypt ? 'encrypted' : 'plain');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);

  const encrypted = mode === 'encrypted';
  const validation = !encrypted
    ? null
    : passphrase.length < EXPORT_PASSPHRASE_MIN
      ? `Use at least ${EXPORT_PASSPHRASE_MIN} characters.`
      : confirm !== passphrase
        ? "That doesn't match."
        : null;

  const submit = () => {
    setTouched(true);
    if (validation) return;
    const choice: ExportChoice = encrypted ? { encrypt: true, passphrase } : { encrypt: false };
    setPassphrase('');
    setConfirm('');
    onConfirm(choice);
  };

  const cancel = () => {
    setPassphrase('');
    setConfirm('');
    onCancel();
  };

  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
      title="Export message history"
      description={
        canEncrypt
          ? 'The file contains your messages. Unless you encrypt it, anyone who has it can read them.'
          : 'The file contains your messages, and anyone who has it can read them.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant={encrypted ? 'primary' : 'danger'}
            disabled={touched && validation !== null}
            onClick={submit}
          >
            {encrypted ? 'Export encrypted' : 'Export unencrypted'}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.warning} role="note">
          It includes message text, names, phone numbers and reactions. Keep the file somewhere
          private, and delete it when you no longer need it. Snowdrop can&rsquo;t import it again
          yet, so it&rsquo;s a copy for your own records, not a restore point.
        </p>
        {canEncrypt && (
          <Segmented
            label="Export format"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'encrypted', label: 'Encrypted' },
              { value: 'plain', label: 'Unencrypted' },
            ]}
          />
        )}
        {encrypted ? (
          <>
            <p className={styles.muted}>
              Choose a passphrase. You&rsquo;ll need it to open the file, and Snowdrop can&rsquo;t
              recover it if it&rsquo;s lost.
            </p>
            <TextInput
              type="password"
              label="Passphrase"
              data-autofocus
              autoComplete="new-password"
              value={passphrase}
              error={
                touched && passphrase.length < EXPORT_PASSPHRASE_MIN
                  ? `Use at least ${EXPORT_PASSPHRASE_MIN} characters.`
                  : undefined
              }
              onChange={(e) => {
                setPassphrase(e.target.value);
              }}
            />
            <PassphraseStrengthHint passphrase={passphrase} />
            <TextInput
              type="password"
              label="Confirm passphrase"
              autoComplete="new-password"
              value={confirm}
              error={touched && confirm !== passphrase ? "That doesn't match." : undefined}
              onChange={(e) => {
                setConfirm(e.target.value);
              }}
            />
          </>
        ) : (
          <p className={styles.muted}>
            Unencrypted, the file is plain JSON that any program can read.
          </p>
        )}
      </div>
    </Modal>
  );
}
