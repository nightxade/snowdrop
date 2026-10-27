import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { directConversationId, initialsFor, type ConversationId } from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import { useSnowdrop } from '@/ui/hooks';
import { PersonAvatar } from '@/ui/features/conversation';
import { Button, Modal } from '@/ui/primitives';
import { SafetyNumberView } from './SafetyNumberView';
import styles from './safety.module.css';

/** Desktop makes the user step through the list explicitly above this many people. */
const EXPLICIT_REVIEW_OVER = 5;

type Step = 'list' | 'many' | 'review' | 'reviewed';

/**
 * Signal Desktop's "Safety Number Changes" dialog, shown when a send was
 * stopped because someone's safety number changed. Reviewing a number is
 * optional; Send anyway accepts each new key (unless the user verified it) and
 * sends the message again. Cancel leaves it as a failed message with Retry.
 */
export function SafetyNumberChangeDialog({
  conversationId,
  nonce,
  contactIds,
  onClose,
}: {
  conversationId: ConversationId;
  nonce: string;
  contactIds: readonly string[];
  onClose: () => void;
}) {
  const { identity, send, stores } = useSnowdrop();
  const trust = useStore(stores.identities, (s) => s.trustById);
  const contacts = useStore(stores.contacts, (s) => s.byId);
  const [step, setStep] = useState<Step>(
    contactIds.length > EXPLICIT_REVIEW_OVER ? 'many' : 'list',
  );
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const allVerified = contactIds.every((id) => trust[id] === 'verified');
  const sendNow = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await identity.approveAll(contactIds);
    setBusy(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    onClose();
    await send.retry(conversationId, nonce);
  };

  if (viewing !== null)
    return (
      <Modal
        open
        size="sm"
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
        title="Verify Safety Number"
      >
        <SafetyNumberView
          contactId={viewing}
          onClose={() => {
            setViewing(null);
          }}
        />
        <Button
          variant="ghost"
          onClick={() => {
            setViewing(null);
          }}
        >
          Back
        </Button>
      </Modal>
    );

  const many = step === 'many';
  const reviewed = step === 'reviewed';
  const listing = step === 'list' || step === 'review';
  const description = many
    ? `You have ${contactIds.length} connections who may have reinstalled Signal or changed devices. You can optionally review their safety numbers before sending.`
    : reviewed
      ? 'All connections have been reviewed, click send to continue.'
      : 'The following people may have reinstalled Signal or changed devices. Click a recipient to confirm their new safety number. This is optional.';
  const sendLabel = many ? 'Send anyway' : reviewed || allVerified ? 'Send' : 'Send anyway';

  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Safety Number Changes"
      description={description}
      footer={
        <>
          <Button variant="ghost" disabled={busy} data-autofocus="" onClick={onClose}>
            Cancel
          </Button>
          {many && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setStep('review');
              }}
            >
              Review
            </Button>
          )}
          {step === 'review' ? (
            <Button
              variant="primary"
              onClick={() => {
                setStep('reviewed');
              }}
            >
              Done
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void sendNow()}
            >
              {busy ? 'Sending…' : sendLabel}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.changeBody}>
        <span className={styles.shield} aria-hidden>
          <ShieldCheck size={24} />
        </span>
        {listing && (
          <ul className={styles.people} aria-label="People whose safety number changed">
            {contactIds.map((id) => {
              const contact = contacts[id];
              const name = stripBidiControls(contact?.name ?? 'Unknown contact');
              return (
                <li key={id} className={styles.person}>
                  <PersonAvatar
                    contactId={id}
                    conversationId={directConversationId(id)}
                    fallback={initialsFor(name)}
                    color={contact?.color ?? 'var(--snowdrop-text-faint)'}
                    size={32}
                  />
                  <span className={styles.personText}>
                    <span className={styles.personName}>{name}</span>
                    {(contact?.number || trust[id] === 'verified') && (
                      <span className={styles.personSub}>
                        {[contact?.number, trust[id] === 'verified' ? 'Verified' : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`View safety number with ${name}`}
                    onClick={() => {
                      setViewing(id);
                    }}
                  >
                    View
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <p className={styles.problem} role="alert">
          {failed
            ? 'Couldn’t accept the new safety number. Check the connection and try again.'
            : null}
        </p>
      </div>
    </Modal>
  );
}
