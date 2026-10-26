import { useState } from 'react';
import type { ConversationId, GroupPermission, GroupPermissions } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal, Select } from '@/ui/primitives';
import { useGroup } from './useGroup';
import styles from './groups.module.css';

const OPTIONS: readonly { value: GroupPermission; label: string }[] = [
  { value: 'every-member', label: 'All members' },
  { value: 'only-admins', label: 'Only admins' },
];

const ROWS: readonly {
  key: keyof GroupPermissions;
  label: string;
  hint: string;
}[] = [
  {
    key: 'addMember',
    label: 'Who can add members',
    hint: 'Choose who can add members to this group.',
  },
  {
    key: 'editDetails',
    label: 'Who can edit group info',
    hint: 'Choose who can edit the group name, photo, description and disappearing messages timer.',
  },
  {
    key: 'sendMessages',
    label: 'Who can send messages',
    hint: 'Choose who can send messages to the group. Everyone can still read them.',
  },
];

/**
 * The group's three rules (Desktop's Permissions panel, admins only). Each
 * change goes out as soon as it is picked; the control keeps its old value
 * until Signal agrees, and shows busy while it waits.
 */
export function PermissionsDialog({
  conversationId,
  onClose,
}: {
  conversationId: ConversationId;
  onClose: () => void;
}) {
  const app = useSnowdrop();
  const { group, canManage } = useGroup(conversationId);
  const [pending, setPending] = useState<keyof GroupPermissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!group) return null;
  const rules = group.permissions;

  const change = async (key: keyof GroupPermissions, value: GroupPermission) => {
    if (pending) return;
    setPending(key);
    setError(null);
    const failure = await app.groups.update(conversationId, { permissions: { [key]: value } });
    setPending(null);
    if (failure !== null) setError(failure);
  };

  return (
    <Modal
      open
      size="md"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Permissions"
      description="Only admins can change who is allowed to do what in this group."
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <ul className={styles.rules}>
        {ROWS.map((row) => (
          <li key={row.key} className={styles.rule}>
            <div className={styles.ruleText}>
              <label className={styles.ruleLabel} htmlFor={`rule-${row.key}`}>
                {row.label}
              </label>
              <p id={`rule-${row.key}-hint`} className={styles.note}>
                {row.hint}
              </p>
            </div>
            <Select<GroupPermission>
              id={`rule-${row.key}`}
              aria-describedby={`rule-${row.key}-hint`}
              value={rules?.[row.key] ?? 'every-member'}
              options={OPTIONS}
              disabled={!canManage || pending !== null || rules === undefined}
              aria-busy={pending === row.key}
              onValueChange={(value) => void change(row.key, value)}
            />
          </li>
        ))}
      </ul>
      <p className={styles.status} role="status">
        {pending ? 'Saving…' : ''}
      </p>
      <p className={styles.error} role="alert">
        {error}
      </p>
    </Modal>
  );
}
