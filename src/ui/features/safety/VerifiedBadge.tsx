import { BadgeCheck } from 'lucide-react';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { identitiesSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import styles from './safety.module.css';

/**
 * Desktop's "Verified" mark beside a person's name: shown while their key is
 * marked verified. Asks the backend once per person per session (a change or
 * a send that fails because of one updates it), and shows nothing when the
 * backend has no safety numbers.
 */
export function VerifiedBadge({ contactId }: { contactId: string | undefined }) {
  const { identity, stores } = useSnowdrop();
  const known = useStore(stores.identities, (s) =>
    contactId === undefined ? true : contactId in s.trustById,
  );
  const verified = useStore(stores.identities, (s) =>
    contactId === undefined ? false : identitiesSelectors.verified(contactId)(s),
  );
  useEffect(() => {
    if (contactId !== undefined && !known && identity.available)
      void identity.refreshTrust(contactId);
  }, [identity, contactId, known]);
  if (!verified) return null;
  return (
    <Tooltip label="Verified">
      <span className={styles.badge} role="img" aria-label="Verified" tabIndex={0}>
        <BadgeCheck size={16} aria-hidden />
      </span>
    </Tooltip>
  );
}
