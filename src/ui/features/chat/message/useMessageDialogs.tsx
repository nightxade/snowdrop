import { useState, type ReactNode, type RefObject } from 'react';
import type { Message, MessageId } from '@/core/domain';
import { conversationFocusPolicyActive, useSnowdrop } from '@/ui/hooks';
import { useChatController } from '../ChatController';
import { useRowState } from '../list/rowState';
import * as act from './actions';
import { ConfirmDelete } from './ConfirmDelete';
import { ConfirmEndPoll } from './ConfirmEndPoll';
import { CustomEmojiDialog } from './CustomEmojiPopover';
import { MessageDetails } from './MessageDetails';
import { PollVotesDialog } from './PollCard';
import { StickerPackDialog } from './StickerPackDialog';

export interface MessageDialogCallbacks {
  /** Asks first; a surface that skips the question (Shift) calls `runDelete` instead. */
  confirmDelete: (kind: act.DeleteKind) => void;
  /** Deletes now, then settles keyboard focus. */
  runDelete: (kind: act.DeleteKind) => void;
  openDetails: () => void;
  requestEndPoll: () => void;
  openStickerPack: () => void;
  openCustomEmoji: (name: string) => void;
  openPollVotes: () => void;
}

/**
 * The dialogs one message row can open (delete confirm, details, poll votes, end poll, sticker
 * pack, custom emoji), their open state, and the callbacks that open them. `dialogs` renders
 * only the ones that are open.
 */
export function useMessageDialogs(
  m: Message | undefined,
  row: RefObject<HTMLElement | null>,
  perms: act.MessagePermissions | undefined,
): { callbacks: MessageDialogCallbacks; dialogs: ReactNode } {
  const app = useSnowdrop();
  const chat = useChatController();
  const rows = useRowState();
  const [confirm, setConfirm] = useState<act.DeleteKind | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const [votesOpen, setVotesOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [emojiDialog, setEmojiDialog] = useState<string | null>(null);

  /**
   * After a delete, keep the keyboard somewhere sensible: the next message, else the previous one,
   * else the composer (with Vim's navigation keys on, the message list: M11).
   */
  const focusAfterDelete = () => {
    const all = [
      ...(row.current
        ?.closest('[data-snowdrop="message-log"]')
        ?.querySelectorAll<HTMLElement>('[data-roving-item]') ?? []),
    ];
    const at = all.indexOf(row.current as HTMLElement);
    const around = [all[at + 1], all[at - 1]];
    // After the confirm dialog has closed and restored its own focus.
    setTimeout(() => {
      const target =
        at === -1 ? undefined : around.find((el) => el?.isConnected && el.dataset.messageId);
      const id = target?.dataset.messageId as MessageId | undefined;
      if (target && id) {
        rows.setActive(id);
        target.focus();
      } else if (conversationFocusPolicyActive()) chat.navigation?.focus();
      else chat.focusComposer();
    }, 60);
  };
  const runDelete = (kind: act.DeleteKind) => {
    if (!m) return;
    if (kind === 'everyone') act.deleteForEveryone(app, m);
    else if (kind === 'admin') act.adminDelete(app, m);
    else act.deleteForMe(app, m);
    focusAfterDelete();
  };

  const callbacks: MessageDialogCallbacks = {
    confirmDelete: setConfirm,
    runDelete,
    openDetails: () => {
      setDetailsOpen(true);
    },
    requestEndPoll: () => {
      setEndOpen(true);
    },
    openStickerPack: () => {
      setPackOpen(true);
    },
    openCustomEmoji: setEmojiDialog,
    openPollVotes: () => {
      setVotesOpen(true);
    },
  };

  // A message deleted for everyone (here or on another device) leaves nothing to delete for
  // everyone or to give details of: those dialogs close, as any dialog whose subject goes does.
  const gone = m?.deleted === true;
  const dialogs = m && (
    <>
      {confirm && !(gone && confirm !== 'me') && (
        <ConfirmDelete
          kind={confirm}
          message={m}
          onConfirm={() => {
            runDelete(confirm);
            setConfirm(null);
          }}
          onCancel={() => {
            setConfirm(null);
          }}
        />
      )}
      {detailsOpen && !gone && <MessageDetails message={m} onOpenChange={setDetailsOpen} />}
      {votesOpen && m.poll && (
        <PollVotesDialog
          poll={m.poll}
          conversationId={m.conversationId}
          onEnd={
            perms?.canEndPoll
              ? () => {
                  setVotesOpen(false);
                  setEndOpen(true);
                }
              : undefined
          }
          onOpenChange={setVotesOpen}
        />
      )}
      {endOpen && m.poll && (
        <ConfirmEndPoll
          question={m.poll.question}
          onConfirm={() => {
            setEndOpen(false);
            void act.endPoll(app, m);
          }}
          onCancel={() => {
            setEndOpen(false);
          }}
        />
      )}
      {packOpen && m.sticker && (
        <StickerPackDialog
          conversationId={m.conversationId}
          sticker={m.sticker}
          onOpenChange={setPackOpen}
          // The sticker button isn't always focused after a click (WebKit), so name it.
          returnFocus={() =>
            row.current?.querySelector<HTMLElement>('[data-open-attachment]') ?? row.current
          }
        />
      )}
      {emojiDialog !== null &&
        (() => {
          const delivery = m.customEmoji?.find((d) => d.name === emojiDialog);
          return delivery ? (
            <CustomEmojiDialog
              conversationId={m.conversationId}
              delivery={delivery}
              onOpenChange={(open) => {
                if (!open) setEmojiDialog(null);
              }}
            />
          ) : null;
        })()}
    </>
  );

  return { callbacks, dialogs };
}
