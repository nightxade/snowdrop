import type { ConversationId } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { ConfirmDialog } from '@/ui/primitives';
import { blockCopy, useBlockTarget } from './blocking';

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
  returnFocus,
}: {
  conversationId: ConversationId;
  /** Fixed when the dialog opens, so the wording doesn't flip while it closes. */
  unblock: boolean;
  onClose: () => void;
  /** Called once it went through, just before `onClose`. */
  onDone?: () => void;
  /** Where focus goes on close, when not back on the opener. */
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const { requests } = useSnowdrop();
  const target = useBlockTarget(conversationId);
  if (!target) return null;

  const copy = blockCopy(target, unblock);
  const blockedByAdminRole = !unblock && target.onlyAdmin;
  const run = async (): Promise<string | null> => {
    const done = await (unblock
      ? requests.unblock(conversationId)
      : requests.block(conversationId));
    if (!done) {
      return `Couldn't ${unblock ? 'unblock' : 'block'} ${target.group ? 'this group' : 'them'}. Check the connection and try again.`;
    }
    onDone?.();
    return null;
  };

  return (
    <ConfirmDialog
      title={copy.title}
      description={
        blockedByAdminRole
          ? 'You are the only admin of this group. Leave it first and choose a new admin, then you can block it.'
          : copy.body
      }
      confirmLabel={copy.confirm}
      busyLabel={copy.busy}
      danger={!unblock}
      disabled={blockedByAdminRole}
      run={run}
      onClose={onClose}
      {...(returnFocus ? { returnFocus } : {})}
    />
  );
}
