import { Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { ConversationId, GroupLinkMode } from '@/core/domain';
import { copyText } from '@/ui/features/conversation';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal, Switch } from '@/ui/primitives';
import { QrCode } from '@/ui/primitives/QrCode';
import { ActionDialog } from './ActionDialog';
import { useGroup } from './useGroup';
import styles from './groups.module.css';

/**
 * The group link (Desktop's "Group link" panel): turn it on, with or without
 * admin approval, or off; copy it, show it as a QR code, or reset it so the
 * old one stops working. Only admins change anything.
 *
 * signal-cli reports the link but not whether it needs approval, so that
 * choice shows as picked only after it was made in this dialog.
 */
export function GroupLinkDialog({
  conversationId,
  onClose,
}: {
  conversationId: ConversationId;
  onClose: () => void;
}) {
  const app = useSnowdrop();
  const { group, canManage } = useGroup(conversationId);
  const [mode, setMode] = useState<GroupLinkMode | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  if (!group) return null;
  const link = group.inviteLink;

  const apply = async (what: string, next: GroupLinkMode) => {
    if (pending) return;
    setPending(what);
    setError(null);
    const failure = await app.groups.update(conversationId, { link: next });
    setPending(null);
    if (failure !== null) setError(failure);
    else if (next !== 'off') setMode(next);
  };

  if (confirmReset) {
    return (
      <ActionDialog
        title="Reset the group link?"
        description="People will no longer be able to join the group using the current link."
        confirmLabel="Reset link"
        busyLabel="Resetting…"
        danger
        run={() => app.groups.update(conversationId, { resetLink: true })}
        onClose={() => {
          setConfirmReset(false);
        }}
      />
    );
  }

  const locked = !canManage || pending !== null;
  return (
    <Modal
      open
      size="md"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Group link"
      description="Anyone with the link can ask to join, or join straight away, depending on the setting below."
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className={styles.linkBody}>
        <Switch
          label="Group link"
          description={link ? 'On' : 'Off'}
          checked={link !== undefined}
          disabled={locked}
          onCheckedChange={(on) => {
            void apply('link', on ? (mode === 'approval' ? 'approval' : 'on') : 'off');
          }}
        />
        {link && (
          <>
            <div className={styles.linkCard}>
              <code className={styles.linkText} data-testid="group-link">
                {link}
              </code>
              <Button
                size="sm"
                icon={<Copy size={14} />}
                onClick={() => {
                  void copyText(app, link, 'group link');
                }}
              >
                Copy link
              </Button>
            </div>
            <div className={styles.qr}>
              <QrCode value={link} size={168} label="QR code for the group link" />
            </div>
            <fieldset className={styles.approval} disabled={locked}>
              <legend className={styles.fieldLabel}>When someone opens the link</legend>
              <div className={styles.approvalButtons}>
                <Button
                  size="sm"
                  aria-pressed={mode === 'on'}
                  variant={mode === 'on' ? 'primary' : 'secondary'}
                  onClick={() => void apply('mode', 'on')}
                >
                  They join right away
                </Button>
                <Button
                  size="sm"
                  aria-pressed={mode === 'approval'}
                  variant={mode === 'approval' ? 'primary' : 'secondary'}
                  onClick={() => void apply('mode', 'approval')}
                >
                  An admin approves them
                </Button>
              </div>
              {mode === null && (
                <p className={styles.note}>
                  Signal doesn’t tell Snowdrop which of these is set now. Pick one to change it.
                </p>
              )}
            </fieldset>
            <div>
              <Button
                size="sm"
                icon={<RefreshCw size={14} />}
                disabled={locked}
                onClick={() => {
                  setConfirmReset(true);
                }}
              >
                Reset link
              </Button>
            </div>
          </>
        )}
        <p className={styles.status} role="status">
          {pending ? 'Saving…' : ''}
        </p>
        <p className={styles.error} role="alert">
          {error}
        </p>
      </div>
    </Modal>
  );
}
