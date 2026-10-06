import { LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import type { StorageAdmin, StorageStatus, StorageUnlockMethod } from '@/core/backend';
import { friendlyErrorMessage } from '@/ui/lib/connectionErrors';
import { Button, Checkbox, Modal, Segmented, TextInput } from '@/ui/primitives';
import { OnboardingShell } from './OnboardingShell';
import setupStyles from './Setup.module.css';
import { errorKind, tryAgainLabel, unlockReasonCopy } from './storageCopy';
import styles from './Storage.module.css';

export interface UnlockScreenProps {
  /** `state: 'locked'`. */
  status: StorageStatus;
  admin: StorageAdmin;
  /** Every status change — a successful unlock, a re-check, or an erase — is reported the same way. */
  onStatusChange: (status: StorageStatus) => void;
}

const ERASE_WORD = 'ERASE';

/**
 * Shown while storage is locked (docs/ENCRYPTION.md, "UX" §3): no keyring
 * service, a locked or empty keyring, or passphrase mode. Purely controlled
 * by `status` — a status change (unlock, retry, erase) is reported upward
 * and `StorageGate` re-routes from the new status.
 */
export function UnlockScreen({ status, admin, onStatusChange }: UnlockScreenProps) {
  const [method, setMethod] = useState<StorageUnlockMethod>(
    status.hasRecovery ? 'recovery' : 'passphrase',
  );
  const [secret, setSecret] = useState('');
  const [remember, setRemember] = useState(status.reason !== 'keyringUnavailable');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);

  const canUnlock = status.hasRecovery || status.hasPassphrase;
  const reason = unlockReasonCopy(status.reason, canUnlock);
  const bothMethods = status.hasRecovery && status.hasPassphrase;
  // Keyring-related reasons can clear themselves without touching the data at
  // all — unlocking or starting the keyring and checking again costs nothing,
  // so it stays on offer even with no recovery key or passphrase to fall
  // back on. `keyringSecretMissing` is the one case where it's a long shot
  // (the secret itself is gone, not just inaccessible) rather than the main
  // way forward, so it's offered but not made the primary action.
  const offerKeyringRetry =
    status.reason === 'keyringLocked' ||
    status.reason === 'keyringUnavailable' ||
    status.reason === 'keyringSecretMissing';
  const keyringRetryIsPrimary =
    status.reason === 'keyringLocked' || status.reason === 'keyringUnavailable';

  const tryAgain = async () => {
    setChecking(true);
    setError(null);
    try {
      onStatusChange(await admin.status());
    } catch (e) {
      setError(friendlyErrorMessage(errorKind(e), e instanceof Error ? e.message : String(e)));
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onStatusChange(await admin.unlock(method, secret, remember));
      setSecret('');
    } catch (e) {
      setError(friendlyErrorMessage(errorKind(e), e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OnboardingShell>
      <section className={setupStyles.card} aria-labelledby="unlock-title" data-snowdrop="unlock">
        <h2 id="unlock-title" className={setupStyles.title}>
          <span className={styles.titleRow}>
            <LockKeyhole size={18} aria-hidden />
            {reason.title}
          </span>
        </h2>
        <p className={setupStyles.lede}>{reason.body}</p>
        {canUnlock ? (
          <form
            className={styles.fields}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {bothMethods && (
              <Segmented
                label="Unlock method"
                value={method}
                onValueChange={(v) => {
                  setMethod(v);
                  setError(null);
                }}
                options={[
                  { value: 'recovery', label: 'Recovery key' },
                  { value: 'passphrase', label: 'Passphrase' },
                ]}
              />
            )}
            <TextInput
              type={method === 'passphrase' ? 'password' : 'text'}
              label={method === 'recovery' ? 'Recovery key' : 'Passphrase'}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
              }}
            />
            {error && (
              <p className={setupStyles.error} role="alert">
                {error}
              </p>
            )}
            <Checkbox
              className={styles.rememberRow}
              checked={remember}
              onCheckedChange={setRemember}
            >
              Remember on this device
            </Checkbox>
            <div className={setupStyles.actions}>
              <Button type="submit" variant="primary" disabled={busy || !secret.trim()}>
                Unlock
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={checking}
                onClick={() => void tryAgain()}
              >
                {tryAgainLabel(status.reason)}
              </Button>
            </div>
          </form>
        ) : keyringRetryIsPrimary ? (
          // No recovery key or passphrase, but the keyring itself might just
          // need unlocking or starting — that costs no data, so it leads,
          // with Start fresh kept as the (data-losing) fallback.
          <div className={setupStyles.actions}>
            <Button
              type="button"
              variant="primary"
              autoFocus
              disabled={checking}
              onClick={() => void tryAgain()}
            >
              {tryAgainLabel(status.reason)}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEraseOpen(true);
              }}
            >
              Start fresh…
            </Button>
          </div>
        ) : (
          // Either no recovery key/passphrase and no keyring angle left to
          // try (docs/ENCRYPTION.md, "UX" §3), or the keyring secret itself
          // is gone — a re-check might still turn it up, but starting over
          // is the reliable way forward, so it leads here.
          <div className={setupStyles.actions}>
            <Button
              type="button"
              variant="danger"
              autoFocus
              onClick={() => {
                setEraseOpen(true);
              }}
            >
              Start fresh…
            </Button>
            {offerKeyringRetry && (
              <Button
                type="button"
                variant="ghost"
                disabled={checking}
                onClick={() => void tryAgain()}
              >
                {tryAgainLabel(status.reason)}
              </Button>
            )}
          </div>
        )}
        {eraseOpen && (
          <StartFreshDialog
            admin={admin}
            onClose={() => {
              setEraseOpen(false);
            }}
            onErased={(s) => {
              setEraseOpen(false);
              onStatusChange(s);
            }}
          />
        )}
      </section>
    </OnboardingShell>
  );
}

function StartFreshDialog({
  admin,
  onClose,
  onErased,
}: {
  admin: StorageAdmin;
  onClose: () => void;
  onErased: (status: StorageStatus) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmErase = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await admin.eraseAll();
      // Report the new status first: if restart() is slow (or this build's
      // restart doesn't tear the webview down immediately), StorageGate can
      // still show "Restart Snowdrop to finish" from `restartRequired`
      // rather than leaving this dialog spinning.
      onErased(result.status);
      // One-shot per process (docs/ENCRYPTION.md, "Erase") — matches
      // EncryptionSection's DangerZone erase flow.
      await admin.restart();
    } catch (e) {
      setError(friendlyErrorMessage(errorKind(e), e instanceof Error ? e.message : String(e)));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Start fresh?"
      description="This erases this computer’s encrypted data for good. You’ll re-link to your phone."
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy || typed !== ERASE_WORD}
            onClick={() => void confirmErase()}
          >
            Erase and start fresh
          </Button>
        </>
      }
    >
      <ul className={styles.eraseList}>
        <li>
          <strong>Comes back:</strong> your Signal identity on this computer, as a new linked
          device, plus contacts and groups synced from your phone.
        </li>
        <li>
          <strong>Gone:</strong> this computer&rsquo;s copy of your message history, and
          Snowdrop&rsquo;s own data — settings, spaces/folders, drafts, keyword alerts, and contact
          notes and pronouns.
        </li>
      </ul>
      <TextInput
        label={`Type ${ERASE_WORD} to confirm`}
        data-autofocus
        autoComplete="off"
        spellCheck={false}
        value={typed}
        error={error ?? undefined}
        onChange={(e) => {
          setTyped(e.target.value);
          setError(null);
        }}
      />
    </Modal>
  );
}
