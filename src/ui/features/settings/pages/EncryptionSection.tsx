/**
 * Settings → Privacy & security's encryption controls (desktop only;
 * docs/ENCRYPTION.md, "UX" §4 and §5): status, recovery key, passphrase,
 * keyring and "Erase all local data". Shown only when `app.storageAdmin` is
 * set — the same pattern `ConnectionPage` uses for `DesktopConnectionRows`
 * with `app.desktop`.
 */
import {
  CircleCheck,
  KeyRound,
  LoaderCircle,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { StorageAdmin, StorageStatus } from '@/core/backend';
import {
  errorKind,
  friendlyKeyringBackend,
  PassphraseStrengthHint,
  RecoveryKeyReveal,
} from '@/ui/features/onboarding';
import { useSnowdrop } from '@/ui/hooks';
import { friendlyErrorMessage } from '@/ui/lib/connectionErrors';
import { Button, IconButton, Modal, TextInput } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import styles from './pages.module.css';

const ERASE_WORD = 'ERASE';

function describeError(e: unknown): string {
  return friendlyErrorMessage(errorKind(e), e instanceof Error ? e.message : String(e));
}

export interface EncryptionSectionProps {
  admin: StorageAdmin;
}

/** Entry point: loads `StorageStatus` once, then renders every subsection. */
export function EncryptionSection({ admin }: EncryptionSectionProps) {
  const [status, setStatus] = useState<StorageStatus | { error: string } | null>(null);

  useEffect(() => {
    let live = true;
    admin.status().then(
      (s) => {
        if (live) setStatus(s);
      },
      (e: unknown) => {
        if (live) setStatus({ error: describeError(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [admin]);

  if (status === null) {
    return (
      <SettingsSection id="encryption" title="Encryption">
        <SettingRow
          id="privacy.encryptionStatus"
          label="Encrypted on this computer"
          description="Checking…"
        />
      </SettingsSection>
    );
  }
  if ('error' in status) {
    return (
      <SettingsSection id="encryption" title="Encryption">
        <SettingRow
          id="privacy.encryptionStatus"
          label="Encrypted on this computer"
          noteTone="danger"
          note={status.error}
        />
      </SettingsSection>
    );
  }

  return (
    <>
      <StatusSection status={status} />
      <RecoverySection admin={admin} status={status} onStatusChange={setStatus} />
      <PassphraseSection admin={admin} status={status} onStatusChange={setStatus} />
      <KeyringSection admin={admin} onStatusChange={setStatus} />
      <DangerZone admin={admin} />
    </>
  );
}

function StatusSection({ status }: { status: StorageStatus }) {
  const description = status.hasKeyring
    ? `Key kept in ${friendlyKeyringBackend(status.keyringBackend)}.`
    : status.hasPassphrase
      ? 'Snowdrop asks for your passphrase at every launch.'
      : 'Unlocked for this session only — add a keyring or passphrase below so Snowdrop can unlock automatically next time.';
  return (
    <SettingsSection id="encryption" title="Encryption">
      <SettingRow
        id="privacy.encryptionStatus"
        label="Encrypted on this computer"
        description={description}
        noteTone={status.vaultDisabled ? 'warning' : 'info'}
        note={
          status.vaultDisabled ? (
            <>
              <ShieldAlert size={14} aria-hidden /> signal-cli&rsquo;s data is managed outside
              Snowdrop (an external daemon, or a configured override) and isn&rsquo;t encrypted by
              Snowdrop. Everything described above still is.
            </>
          ) : undefined
        }
      />
    </SettingsSection>
  );
}

type RecoveryFlow =
  | { kind: 'idle' }
  | { kind: 'confirmReplace' }
  | { kind: 'reveal'; code: string }
  | { kind: 'confirmRemove' };

function RecoverySection({
  admin,
  status,
  onStatusChange,
}: {
  admin: StorageAdmin;
  status: StorageStatus;
  onStatusChange: (status: StorageStatus) => void;
}) {
  const [flow, setFlow] = useState<RecoveryFlow>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reminderDismissed, setReminderDismissed] = useState(false);

  // docs/ENCRYPTION.md, "Key hierarchy": removing a slot that would leave
  // `keys.json` with zero of them (no keyring, recovery or passphrase) is
  // refused server-side; this disables the button pre-emptively instead of
  // letting someone hit that error.
  const isLastMethod = !status.hasKeyring && !status.hasPassphrase;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await admin.createRecovery();
      onStatusChange(result.status);
      setFlow({ kind: 'reveal', code: result.code });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onStatusChange(await admin.removeRecovery());
      setFlow({ kind: 'idle' });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id="recovery"
      title="Recovery key"
      rowIds={['privacy.recoveryKey', 'privacy.removeRecoveryKey']}
    >
      {!status.hasRecovery && !reminderDismissed && (
        <div className={styles.reminder}>
          <p>
            A recovery key lets Snowdrop unlock your data if you switch keyrings or reinstall —
            without one, losing the keyring means starting fresh.
          </p>
          <IconButton
            size="sm"
            label="Dismiss"
            icon={<X size={14} />}
            onClick={() => {
              setReminderDismissed(true);
            }}
          />
        </div>
      )}
      <SettingRow
        id="privacy.recoveryKey"
        label="Recovery key"
        description={
          status.hasRecovery
            ? 'Lets Snowdrop unlock your data if you switch keyrings or reinstall.'
            : 'Not set up yet.'
        }
        noteTone={error ? 'danger' : 'info'}
        note={flow.kind === 'idle' ? (error ?? undefined) : undefined}
        control={
          <Button
            icon={
              busy && flow.kind === 'idle' ? (
                <LoaderCircle size={16} className={styles.spin} />
              ) : (
                <KeyRound size={16} />
              )
            }
            disabled={busy}
            onClick={() => {
              setError(null);
              if (status.hasRecovery) setFlow({ kind: 'confirmReplace' });
              else void create();
            }}
          >
            {status.hasRecovery ? 'Replace…' : 'Create recovery key'}
          </Button>
        }
      />
      {status.hasRecovery && (
        <SettingRow
          id="privacy.removeRecoveryKey"
          label="Remove recovery key"
          description={
            isLastMethod
              ? "This is the only way left to unlock Snowdrop — add a keyring or passphrase first."
              : "You won't be able to use it to unlock your data any more."
          }
          control={
            <Button
              variant="danger"
              disabled={isLastMethod}
              title={
                isLastMethod ? 'Add another unlock method before removing this one.' : undefined
              }
              onClick={() => {
                setError(null);
                setFlow({ kind: 'confirmRemove' });
              }}
            >
              Remove…
            </Button>
          }
        />
      )}
      {flow.kind === 'confirmReplace' && (
        <Modal
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open && !busy) setFlow({ kind: 'idle' });
          }}
          title="Replace recovery key?"
          description="Creating a new one immediately stops the old key working — anyone who saved it won't be able to use it any more."
          footer={
            <>
              <Button
                variant="ghost"
                data-autofocus
                disabled={busy}
                onClick={() => {
                  setFlow({ kind: 'idle' });
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void create()}>
                Create new key
              </Button>
            </>
          }
        >
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
      {flow.kind === 'reveal' && (
        <Modal
          open
          size="md"
          onOpenChange={(open) => {
            if (!open) setFlow({ kind: 'idle' });
          }}
          title="Your recovery key"
          description="Save this somewhere safe. Anyone with it — and access to this computer's data — could unlock it, so keep it as carefully as a password."
        >
          <RecoveryKeyReveal
            code={flow.code}
            onConfirmed={() => {
              setFlow({ kind: 'idle' });
            }}
          />
        </Modal>
      )}
      {flow.kind === 'confirmRemove' && (
        <Modal
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open && !busy) setFlow({ kind: 'idle' });
          }}
          title="Remove recovery key?"
          description="Without it, losing the keyring means starting fresh: re-linking and losing this computer's message history."
          footer={
            <>
              <Button
                variant="ghost"
                data-autofocus
                disabled={busy}
                onClick={() => {
                  setFlow({ kind: 'idle' });
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                Remove
              </Button>
            </>
          }
        >
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </SettingsSection>
  );
}

type PassphraseFlow = { kind: 'idle' } | { kind: 'edit' } | { kind: 'confirmRemove' };

function PassphraseSection({
  admin,
  status,
  onStatusChange,
}: {
  admin: StorageAdmin;
  status: StorageStatus;
  onStatusChange: (status: StorageStatus) => void;
}) {
  const [flow, setFlow] = useState<PassphraseFlow>({ kind: 'idle' });
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // See RecoverySection's matching guard: the same "zero slots left" rule,
  // the other way around.
  const isLastMethod = !status.hasKeyring && !status.hasRecovery;

  const validation =
    value.length === 0
      ? 'Enter a passphrase.'
      : value.length < 8
        ? 'Use at least 8 characters.'
        : confirm !== value
          ? "That doesn't match."
          : null;

  const openEdit = () => {
    setValue('');
    setConfirm('');
    setTouched(false);
    setError(null);
    setFlow({ kind: 'edit' });
  };

  // Never kept around in state longer than it has to be: cleared after a
  // successful save and on cancel alike (task: passphrase hygiene).
  const closeEdit = () => {
    setFlow({ kind: 'idle' });
    setValue('');
    setConfirm('');
  };

  const save = async () => {
    setTouched(true);
    if (validation) return;
    setBusy(true);
    setError(null);
    try {
      onStatusChange(await admin.setPassphrase(value));
      closeEdit();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onStatusChange(await admin.setPassphrase(null));
      setFlow({ kind: 'idle' });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="passphrase" title="Passphrase" rowIds={['privacy.passphrase']}>
      <SettingRow
        id="privacy.passphrase"
        label="Passphrase"
        description={
          status.hasPassphrase && isLastMethod
            ? "This is the only way left to unlock Snowdrop — add a keyring or recovery key first to remove it."
            : status.hasPassphrase
              ? 'Snowdrop asks for this passphrase at every launch, instead of (or alongside) the keyring.'
              : 'Off. Add one to unlock with a passphrase instead of (or alongside) the keyring.'
        }
        control={
          <div className={styles.rowActions}>
            <Button onClick={openEdit}>{status.hasPassphrase ? 'Change…' : 'Add passphrase'}</Button>
            {status.hasPassphrase && (
              <Button
                variant="danger"
                disabled={isLastMethod}
                title={
                  isLastMethod ? 'Add another unlock method before removing this one.' : undefined
                }
                onClick={() => {
                  setError(null);
                  setFlow({ kind: 'confirmRemove' });
                }}
              >
                Remove…
              </Button>
            )}
          </div>
        }
      />
      {flow.kind === 'edit' && (
        <Modal
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open && !busy) closeEdit();
          }}
          title={status.hasPassphrase ? 'Change passphrase' : 'Add a passphrase'}
          description="Snowdrop will ask for this passphrase every time it starts."
          footer={
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={closeEdit}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || (touched && !!validation)}
                onClick={() => void save()}
              >
                Save
              </Button>
            </>
          }
        >
          <div className={styles.stack}>
            <TextInput
              type="password"
              label="New passphrase"
              data-autofocus
              autoComplete="new-password"
              value={value}
              error={
                touched && value.length > 0 && value.length < 8
                  ? 'Use at least 8 characters.'
                  : undefined
              }
              onChange={(e) => {
                setValue(e.target.value);
              }}
              onBlur={() => {
                setTouched(true);
              }}
            />
            <PassphraseStrengthHint passphrase={value} />
            <TextInput
              type="password"
              label="Confirm passphrase"
              autoComplete="new-password"
              value={confirm}
              error={
                touched && confirm.length > 0 && confirm !== value
                  ? "That doesn't match."
                  : undefined
              }
              onChange={(e) => {
                setConfirm(e.target.value);
              }}
              onBlur={() => {
                setTouched(true);
              }}
            />
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </div>
        </Modal>
      )}
      {flow.kind === 'confirmRemove' && (
        <Modal
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open && !busy) setFlow({ kind: 'idle' });
          }}
          title="Remove passphrase?"
          description="Snowdrop will no longer ask for it at launch. Make sure a keyring or recovery key can still unlock your data."
          footer={
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setFlow({ kind: 'idle' });
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                Remove
              </Button>
            </>
          }
        >
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </SettingsSection>
  );
}

function KeyringSection({
  admin,
  onStatusChange,
}: {
  admin: StorageAdmin;
  onStatusChange: (status: StorageStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true } | { ok: false; message: string } | null>(null);

  const reenroll = async () => {
    setBusy(true);
    setResult(null);
    try {
      onStatusChange(await admin.enrollKeyring());
      setResult({ ok: true });
    } catch (e) {
      setResult({ ok: false, message: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="keyring" title="Keyring" rowIds={['privacy.keyring']}>
      <SettingRow
        id="privacy.keyring"
        label="Re-save key to this keyring"
        description="After switching keyring apps (or recovering one that was wiped), save Snowdrop's key to it again."
        control={
          <Button
            icon={
              busy ? <LoaderCircle size={16} className={styles.spin} /> : <KeyRound size={16} />
            }
            disabled={busy}
            onClick={() => void reenroll()}
          >
            Re-save
          </Button>
        }
        noteTone={result ? (result.ok ? 'success' : 'danger') : 'info'}
        note={
          result ? (
            result.ok ? (
              <>
                <CircleCheck size={14} aria-hidden /> Saved.
              </>
            ) : (
              result.message
            )
          ) : undefined
        }
      />
    </SettingsSection>
  );
}

function DangerZone({ admin }: { admin: StorageAdmin }) {
  const app = useSnowdrop();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setTyped('');
    setError(null);
  };

  const confirmErase = async () => {
    setBusy(true);
    setError(null);
    try {
      // Nothing may write local data back after it's gone: stop persistence
      // before erasing (docs/ENCRYPTION.md, "Erase") — otherwise a lingering
      // debounced write, or the pagehide flush that fires as the app closes
      // to restart, could re-create what was just erased.
      app.admin.stopPersistence();
      await admin.eraseAll();
      await admin.restart();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Danger zone" rowIds={['privacy.eraseAll']}>
      <SettingRow
        id="privacy.eraseAll"
        label="Erase all local data"
        description="Deletes this computer's encrypted keys, signal-cli data and Snowdrop's own settings, for good."
        control={
          <Button
            variant="danger"
            icon={<Trash2 size={16} />}
            onClick={() => {
              setOpen(true);
            }}
          >
            Erase…
          </Button>
        }
      />
      {open && (
        <Modal
          open
          size="sm"
          onOpenChange={(next) => {
            if (!next && !busy) close();
          }}
          title="Erase all local data?"
          description="This can't be undone."
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy || typed !== ERASE_WORD}
                onClick={() => void confirmErase()}
              >
                {busy ? 'Erasing…' : 'Erase and restart'}
              </Button>
            </>
          }
        >
          <ul className={styles.list} style={{ marginBottom: 'var(--snowdrop-space-5)' }}>
            <li>
              <strong>Deleted:</strong> this computer&rsquo;s encrypted signal-cli vault (keys,
              sessions, contacts and message history), your recovery key, passphrase and keyring
              entry, and Snowdrop&rsquo;s own settings, spaces and drafts in this browser.
            </li>
            <li>
              <strong>Not deleted:</strong> your Signal account. This computer stays listed as a
              linked device until you remove it yourself — on your phone, Signal → Settings →
              Linked devices.
            </li>
          </ul>
          <TextInput
            label={`Type ${ERASE_WORD} to confirm`}
            data-autofocus
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
            }}
          />
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <p className={styles.muted}>Snowdrop will restart once this finishes.</p>
        </Modal>
      )}
    </SettingsSection>
  );
}
