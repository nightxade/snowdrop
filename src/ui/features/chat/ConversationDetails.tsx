import { Copy, Pencil, Timer } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { useStore } from 'zustand';
import { formatDuration, type ConversationView } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useShrike } from '@/ui/hooks';
import {
  ConversationAvatar,
  copyText,
  updateConversation,
  usePeer,
} from '@/ui/features/conversation';
import { Button, TextInput } from '@/ui/primitives';
import styles from './ConversationDetails.module.css';

const MAX_GROUP_NAME = 32;

/** The "about this conversation" popover opened from the header title. */
export function ConversationDetails({ conversation }: { conversation: ConversationView }) {
  const app = useShrike();
  const peer = usePeer(conversation);
  const selfId = useStore(app.stores.session, sessionSelectors.selfId);
  const isGroup = conversation.kind === 'group';
  const about = isGroup ? conversation.description : peer?.about;
  // Signal lets admins rename a group (the default "edit group info" access).
  const canRename =
    isGroup &&
    app.send.capabilities.updateConversation &&
    selfId !== null &&
    conversation.adminIds.includes(selfId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!trimmed || trimmed === conversation.title) {
      setRenaming(false);
      return;
    }
    setSaving(true);
    const ok = await updateConversation(app, conversation.id, { title: trimmed });
    setSaving(false);
    if (ok) setRenaming(false);
  };

  return (
    <div className={styles.details}>
      <div className={styles.top}>
        <ConversationAvatar conversation={conversation} size={48} />
        <div className={styles.names}>
          <p className={styles.title}>{conversation.title}</p>
          <p className={styles.meta}>
            {isGroup
              ? `Group, ${conversation.memberIds.length} members`
              : (peer?.number ?? 'Direct message')}
          </p>
        </div>
      </div>
      {renaming && (
        <form className={styles.rename} onSubmit={(e) => void submit(e)}>
          <TextInput
            label="Group name"
            value={name}
            maxLength={MAX_GROUP_NAME}
            autoFocus
            disabled={saving}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <div className={styles.renameActions}>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setName(conversation.title);
                setRenaming(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={saving || !trimmed}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      )}
      {about && <p className={styles.about}>{about}</p>}
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>
            <Timer size={14} aria-hidden /> Disappearing messages
          </dt>
          <dd>{formatDuration(conversation.expireTimerSec)}</dd>
        </div>
      </dl>
      <div className={styles.actions}>
        {canRename && !renaming && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Pencil size={14} />}
            onClick={() => {
              setName(conversation.title);
              setRenaming(true);
            }}
          >
            Rename group
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={<Copy size={14} />}
          onClick={() => {
            void copyText(app, conversation.id, 'conversation ID');
          }}
        >
          Copy ID
        </Button>
      </div>
    </div>
  );
}
