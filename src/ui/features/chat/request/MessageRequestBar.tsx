import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { ConversationId, MessageRequestState } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import {
  ConversationAvatar,
  formatPhone,
  useConversationView,
  usePeer,
} from '@/ui/features/conversation';
import { Button, Modal } from '@/ui/primitives';
import { useChatController } from '../ChatController';
import styles from './MessageRequestBar.module.css';

type Action = 'accept' | 'delete' | 'block' | 'unblock';
type Confirm = 'delete' | 'block';

const FAILED: Record<Action, string> = {
  accept: "Couldn't accept this request. Try again.",
  delete: "Couldn't delete this request. Try again.",
  block: "Couldn't block this. Try again.",
  unblock: "Couldn't unblock this. Try again.",
};

/**
 * Stands where the composer would be for a conversation the user hasn't
 * accepted (or blocked), like Signal Desktop: nothing can be written until
 * it is answered. Says who it is, what accepting does, and offers Accept,
 * Delete and Block (Unblock for a blocked one) — Delete and Block ask first.
 * Tab reaches every button; nothing takes focus by itself, so Enter can't
 * answer a request the user only meant to read.
 */
export function MessageRequestBar({
  conversationId,
  state,
}: {
  conversationId: ConversationId;
  state: Exclude<MessageRequestState, 'accepted'>;
}) {
  const { requests } = useSnowdrop();
  const chat = useChatController();
  const view = useConversationView(conversationId);
  const peer = usePeer(view);
  const [busy, setBusy] = useState<Action | null>(null);
  const [failed, setFailed] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  if (!view) return null;

  const group = view.kind === 'group';
  const name = group ? view.title : (peer?.name ?? view.title);
  const number = !group && peer?.number && peer.number !== name ? formatPhone(peer.number) : null;
  const detail = group
    ? `Group · ${view.memberIds.length} member${view.memberIds.length === 1 ? '' : 's'}`
    : number;

  const run = async (action: Action) => {
    setBusy(action);
    setFailed(null);
    const done = await {
      accept: () => requests.accept(conversationId),
      delete: () => requests.remove(conversationId),
      block: () => requests.block(conversationId),
      unblock: () => requests.unblock(conversationId),
    }[action]();
    setBusy(null);
    if (!done) setFailed(action);
    // The composer replaces this bar once the chat is accepted.
    else if (action === 'accept' || action === 'unblock')
      window.setTimeout(() => {
        chat.focusComposer();
      }, 0);
  };
  const disabled = busy !== null;

  const copy =
    state === 'blocked'
      ? group
        ? 'You blocked this group. Unblock it to see and send messages here again.'
        : 'You blocked this contact. Unblock them to message them again.'
      : group
        ? "Nobody you know is in this group. If you accept, its members will see your name and photo, and will know when you've read their messages."
        : "If you accept, they will see your name and photo, and will know when you've read their messages. Photos and files from them stay hidden until you do.";

  return (
    <section
      className={styles.bar}
      data-snowdrop="message-request"
      data-pane-title={state === 'blocked' ? 'blocked' : 'message request'}
      data-state={state}
      aria-label={state === 'blocked' ? 'Blocked conversation' : 'Message request'}
    >
      <div className={styles.who} data-part="who">
        <span className={styles.avatar} data-part="avatar">
          <ConversationAvatar conversation={view} size={32} />
        </span>
        <span className={styles.identity} data-part="identity">
          <strong className={styles.name}>
            <bdi>{name}</bdi>
          </strong>
          {detail && <span className={styles.detail}>{detail}</span>}
        </span>
        {state === 'request' && (
          <span className={styles.warning}>
            <ShieldAlert size={14} aria-hidden />
            Review before you accept
          </span>
        )}
      </div>
      <p className={styles.copy}>{copy}</p>
      {failed && (
        <p className={styles.error} role="alert">
          {FAILED[failed]}
        </p>
      )}
      <div className={styles.actions}>
        {state === 'request' && (
          <Button
            variant="ghost"
            className={styles.danger}
            disabled={disabled}
            onClick={() => {
              setConfirm('block');
            }}
          >
            Block
          </Button>
        )}
        <Button
          variant="ghost"
          className={styles.danger}
          disabled={disabled}
          onClick={() => {
            setConfirm('delete');
          }}
        >
          Delete
        </Button>
        {state === 'request' ? (
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => {
              void run('accept');
            }}
          >
            Accept
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => {
              void run('unblock');
            }}
          >
            Unblock
          </Button>
        )}
      </div>
      {confirm && (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          size="sm"
          title={
            confirm === 'delete'
              ? group
                ? 'Delete and leave?'
                : 'Delete this chat?'
              : `Block ${name}?`
          }
          description={
            confirm === 'delete'
              ? group
                ? "You'll leave the group and its messages will be deleted from this device."
                : 'Its messages will be deleted from this device. They are not told.'
              : group
                ? "You won't receive messages or updates from this group."
                : "They won't be able to message you, and they are not told."
          }
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirm(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                data-autofocus
                onClick={() => {
                  const action = confirm;
                  setConfirm(null);
                  void run(action);
                }}
              >
                {confirm === 'delete' ? (group ? 'Delete and leave' : 'Delete') : 'Block'}
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}
