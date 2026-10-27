import { useState } from 'react';
import type { ConversationId } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { blockCopy, useBlockTarget } from './blocking';
import styles from './BlockDialog.module.css';

/**
 * Asks before blocking or unblocking a person or group, with Signal Desktop's
 * wording, then does it. Blocking a group also leaves it (history stays), so
 * the only admin is told to hand the role on first. A failure is read out
 * and stays on screen; the dialog closes only once it went through.
 * Blocking focuses Cancel, so Enter can't block by accident.
 */
export function BlockDialog({
  conversationId,
  unblock,
  onClose,
  onDone,
}: {
  conversationId: ConversationId;
  /** Fixed when the dialog opens, so the wording doesn't flip while it closes. */
  unblock: boolean;
  onClose: () => void;
  /** Called once it went through, just before `onClose`. */
  onDone?: () => void;
}) {
  const { requests } = useSnowdrop();
  const target = useBlockTarget(conversationId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!target) return null;

  const copy = blockCopy(target, unblock);
  const blockedByAdminRole = !unblock && target.onlyAdmin;
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const done = await (unblock
      ? requests.unblock(conversationId)
      : requests.block(conversationId));
    setBusy(false);
    if (done) {
      onDone?.();
      onClose();
    } else setFailed(true);
  };

  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={copy.title}
      description={
        blockedByAdminRole
          ? 'You are the only admin of this group. Leave it first and choose a new admin, then you can block it.'
          : copy.body
      }
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            {...(unblock ? {} : { 'data-autofocus': '' })}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant={unblock ? 'primary' : 'danger'}
            disabled={busy || blockedByAdminRole}
            aria-busy={busy}
            {...(unblock ? { 'data-autofocus': '' } : {})}
            onClick={() => void confirm()}
          >
            {busy ? copy.busy : copy.confirm}
          </Button>
        </>
      }
    >
      <p className={styles.error} role="alert">
        {failed
          ? `Couldn't ${unblock ? 'unblock' : 'block'} ${target.group ? 'this group' : 'them'}. Check the connection and try again.`
          : null}
      </p>
    </Modal>
  );
}
