import { KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { KeyringStatus, StorageAdmin, StorageStatus } from '@/core/backend';
import { friendlyErrorMessage } from '@/ui/lib/connectionErrors';
import { Button, TextInput } from '@/ui/primitives';
import { OnboardingShell } from './OnboardingShell';
import { PassphraseStrengthHint } from './PassphraseStrengthHint';
import { RecoveryKeyReveal } from './RecoveryKeyReveal';
import setupStyles from './Setup.module.css';
import { errorKind, friendlyKeyringBackend } from './storageCopy';
import styles from './Storage.module.css';

export interface StorageSetupProps {
  /** The current `needsSetup` status (only `legacyPlaintext` is read here). */
  status: StorageStatus;
  admin: StorageAdmin;
  /** Setup (and the recovery-key step after it) is finished; `status` is now `unlocked`. */
  onDone: (status: StorageStatus) => void;
}

/**
 * First run, before linking (docs/ENCRYPTION.md, "UX" §1): "Protect your
 * data", then a recovery-key suggestion. Two internal steps, like
 * `Welcome`'s choose/connect — the caller only hears about it once both are
 * done.
 */
export function StorageSetup({ status, admin, onDone }: StorageSetupProps) {
  const [unlocked, setUnlocked] = useState<StorageStatus | null>(null);

  return (
    <OnboardingShell>
      {unlocked ? (
        <RecoveryKeyStep admin={admin} status={unlocked} onDone={onDone} />
      ) : (
        <ProtectYourData
          legacyPlaintext={status.legacyPlaintext}
          admin={admin}
          onProtected={setUnlocked}
        />
      )}
    </OnboardingShell>
  );
}

function ProtectYourData({
  legacyPlaintext,
  admin,
  onProtected,
}: {
  legacyPlaintext: boolean;
  admin: StorageAdmin;
  onProtected: (status: StorageStatus) => void;
}) {
  const [keyring, setKeyring] = useState<KeyringStatus | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void admin.keyringStatus().then((k) => {
      if (live) setKeyring(k);
    });
    return () => {
      live = false;
    };
  }, [admin]);

  const passphraseError =
    passphrase.length === 0
      ? 'Enter a passphrase.'
      : passphrase.length < 8
        ? 'Use at least 8 characters.'
        : confirm !== passphrase
          ? "That doesn't match."
          : null;

  const runSetup = async (mode: 'keyring' | 'passphrase', secret: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const result = await admin.setup(mode, secret);
      // Never kept around longer than it has to be.
      setPassphrase('');
      setConfirm('');
      onProtected(result);
    } catch (e) {
      setError(friendlyErrorMessage(errorKind(e), e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const passphraseForm = (
    <form
      className={styles.fields}
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!passphraseError) void runSetup('passphrase', passphrase);
      }}
    >
      <TextInput
        type="password"
        label="Passphrase"
        autoComplete="new-password"
        autoFocus={!keyring?.available}
        value={passphrase}
        error={
          touched && passphrase.length > 0 && passphrase.length < 8
            ? 'Use at least 8 characters.'
            : undefined
        }
        onChange={(e) => {
          setPassphrase(e.target.value);
        }}
        onBlur={() => {
          setTouched(true);
        }}
      />
      <PassphraseStrengthHint passphrase={passphrase} />
      <TextInput
        type="password"
        label="Confirm passphrase"
        autoComplete="new-password"
        value={confirm}
        error={
          touched && confirm.length > 0 && confirm !== passphrase
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
      <p className={styles.hint}>
        Snowdrop will ask for this passphrase every time it starts.{' '}
        <a
          className={setupStyles.inlineLink}
          href="https://wiki.archlinux.org/title/GNOME/Keyring"
          target="_blank"
          rel="noreferrer"
        >
          Installing a keyring
        </a>{' '}
        lets Snowdrop unlock automatically instead.
      </p>
      <div className={setupStyles.actions}>
        <Button type="submit" variant="primary" disabled={busy || (touched && !!passphraseError)}>
          Continue
        </Button>
      </div>
    </form>
  );

  return (
    <section
      className={setupStyles.card}
      aria-labelledby="protect-title"
      data-snowdrop="storage-setup"
    >
      <h2 id="protect-title" className={setupStyles.title}>
        Protect your data
      </h2>
      <p className={setupStyles.lede}>
        Snowdrop encrypts your keys, sessions, contacts and message history on this computer.
        {legacyPlaintext
          ? ' Snowdrop found an earlier, unencrypted copy of your data; it will be encrypted and the plaintext copy removed.'
          : ''}
      </p>
      {error && (
        <p className={setupStyles.error} role="alert">
          {error}
        </p>
      )}
      {keyring === null ? (
        <p className={styles.hint}>Checking for a keyring…</p>
      ) : keyring.available ? (
        <>
          <div className={styles.methodCard}>
            <p className={styles.methodHeading}>
              <span className={styles.methodIcon}>
                <ShieldCheck size={16} aria-hidden />
              </span>
              The key is kept in {friendlyKeyringBackend(keyring.backend)}.
            </p>
            <div className={setupStyles.actions}>
              <Button
                type="button"
                variant="primary"
                autoFocus
                disabled={busy}
                onClick={() => {
                  void runSetup('keyring', null);
                }}
              >
                Continue
              </Button>
            </div>
          </div>
          <details className={styles.disclosure}>
            <summary>Use a passphrase instead of the keyring</summary>
            {passphraseForm}
          </details>
        </>
      ) : (
        <>
          <p className={setupStyles.muted}>
            No keyring was found on this system, so Snowdrop can&rsquo;t unlock automatically.
            Install one, or use a passphrase instead.
          </p>
          {passphraseForm}
        </>
      )}
    </section>
  );
}

type RecoveryStep = { step: 'offer' } | { step: 'created'; code: string };

function RecoveryKeyStep({
  admin,
  status,
  onDone,
}: {
  admin: StorageAdmin;
  status: StorageStatus;
  onDone: (status: StorageStatus) => void;
}) {
  const [step, setStep] = useState<RecoveryStep>({ step: 'offer' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await admin.createRecovery();
      setStep({ step: 'created', code: result.code });
    } catch (e) {
      setError(friendlyErrorMessage(errorKind(e), e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  if (step.step === 'created') {
    return (
      <section
        className={setupStyles.card}
        aria-labelledby="recovery-title"
        data-snowdrop="recovery-key"
      >
        <h2 id="recovery-title" className={setupStyles.title}>
          Your recovery key
        </h2>
        <p className={setupStyles.lede}>
          Save this somewhere safe. Anyone with it — and access to this computer&rsquo;s data —
          could unlock it, so keep it as carefully as a password.
        </p>
        <RecoveryKeyReveal
          code={step.code}
          onConfirmed={() => {
            setStep({ step: 'offer' });
            onDone(status);
          }}
        />
      </section>
    );
  }

  return (
    <section
      className={setupStyles.card}
      aria-labelledby="recovery-offer-title"
      data-snowdrop="recovery-key"
    >
      <h2 id="recovery-offer-title" className={setupStyles.title}>
        Create a recovery key?
      </h2>
      <p className={setupStyles.lede}>
        If you switch keyrings or reinstall, this lets Snowdrop unlock your data. Without one,
        you&rsquo;d have to re-link and would lose this computer&rsquo;s message history and your
        Snowdrop settings.
      </p>
      {error && (
        <p className={setupStyles.error} role="alert">
          {error}
        </p>
      )}
      <div className={setupStyles.actions}>
        <Button
          type="button"
          variant="primary"
          icon={<KeyRound size={16} />}
          autoFocus
          disabled={busy}
          onClick={() => {
            void create();
          }}
        >
          Create recovery key
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            onDone(status);
          }}
        >
          Skip for now
        </Button>
      </div>
    </section>
  );
}
