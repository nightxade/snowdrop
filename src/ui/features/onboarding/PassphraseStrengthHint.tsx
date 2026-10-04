/**
 * A rough passphrase strength hint (docs/ENCRYPTION.md, "Passphrase slot").
 * Shared by `StorageSetup` (first run) and Settings → Privacy & security
 * (add/change passphrase), so both read the same way.
 */
import { passphraseStrength } from './storageCopy';
import styles from './Storage.module.css';

export function PassphraseStrengthHint({ passphrase }: { passphrase: string }) {
  if (passphrase.length === 0) return null;
  const strength = passphraseStrength(passphrase);
  return (
    <p className={styles.strengthRow}>
      <span className={styles.strengthBar} data-level={strength} aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {strength === 'good'
        ? 'Good passphrase'
        : strength === 'fair'
          ? 'Fair passphrase'
          : 'Weak passphrase'}
    </p>
  );
}
