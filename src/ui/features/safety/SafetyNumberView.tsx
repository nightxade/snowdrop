import { useState } from 'react';
import { useStore } from 'zustand';
import { stripBidiControls } from '@/core/lib';
import { identitiesSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { Button } from '@/ui/primitives';
import { QrCode } from '@/ui/primitives/QrCode';
import { safetyBlocks, useSafetyNumber } from './safetyNumber';
import styles from './safety.module.css';

/**
 * The body of Signal Desktop's safety number viewer: the QR code and the 60
 * digits, "Mark as verified" or "Clear verification", and how to compare.
 * Nothing here is logged or kept; the number lives in this component only.
 */
export function SafetyNumberView({
  contactId,
  onClose,
}: {
  contactId: string;
  /** Closes the viewer (the "can't be verified yet" answer's OK). */
  onClose: () => void;
}) {
  const { identity, stores } = useSnowdrop();
  const name = useStore(stores.contacts, (s) =>
    stripBidiControls(s.byId[contactId]?.name ?? 'this person'),
  );
  const verified = useStore(stores.identities, identitiesSelectors.verified(contactId));
  const { state, reload } = useSafetyNumber(contactId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'changed' | 'failed' | null>(null);

  if (state.status === 'loading')
    return (
      <p className={styles.status} role="status">
        Loading safety number…
      </p>
    );
  if (state.status === 'failed')
    return (
      <p className={styles.problem} role="alert">
        Couldn’t read the safety number. Check the connection and try again.
      </p>
    );
  if (state.status === 'none')
    return (
      <div className={styles.none}>
        <p>This user can’t be verified until you’ve exchanged messages with them.</p>
        <Button variant="primary" onClick={onClose} data-autofocus="">
          OK
        </Button>
      </div>
    );

  const { number } = state;
  const blocks = safetyBlocks(number.digits);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    if (verified) {
      if (!(await identity.clearVerification(contactId))) setProblem('failed');
    } else {
      const result = await identity.verify(contactId, number.digits);
      if (result === 'changed') {
        setProblem('changed');
        await reload();
      } else if (result === 'failed') setProblem('failed');
    }
    setBusy(false);
  };

  return (
    <div className={styles.viewer}>
      <div className={styles.card} data-verified={verified ? '' : undefined}>
        {number.qr && (
          <QrCode
            value={number.qr}
            size={132}
            label={`QR code of your safety number with ${name}. They can scan it to verify.`}
          />
        )}
        <div className={styles.digits} role="group" aria-label={`Safety number with ${name}`}>
          {blocks.map((block, i) => (
            <span key={i} className={styles.block}>
              {block}
            </span>
          ))}
        </div>
        <p className={styles.state}>
          {verified
            ? 'Verified'
            : number.trust === 'untrusted'
              ? 'Not approved yet'
              : 'Not verified'}
        </p>
        <Button
          variant={verified ? 'secondary' : 'primary'}
          aria-busy={busy}
          disabled={busy}
          data-autofocus=""
          onClick={() => void toggle()}
        >
          {verified ? 'Clear verification' : 'Mark as verified'}
        </Button>
      </div>
      <p className={styles.problem} role="alert">
        {problem === 'changed'
          ? `The safety number you are trying to verify has changed. Please review your new safety number with ${name}. Remember, this change could mean that someone is trying to intercept your communication or that ${name} has simply reinstalled Signal.`
          : problem === 'failed'
            ? `Couldn’t ${verified ? 'clear the verification' : 'mark it as verified'}. Check the connection and try again.`
            : null}
      </p>
      {number.trust === 'untrusted' && (
        <p className={styles.hint}>
          Their new safety number isn’t approved yet, so messages with {name} don’t go through until
          you mark it verified, or choose Send anyway after a message fails to send.
        </p>
      )}
      <p className={styles.hint}>
        To verify end-to-end encryption with {name}, compare the numbers above with their device.
        They can also scan your code on their device.
      </p>
    </div>
  );
}
