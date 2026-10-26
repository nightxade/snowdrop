import { ChartBar, CirclePlus, FileUp, Smile, Sticker } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import type { ConversationId, ConversationView } from '@/core/domain';
import { messagesSelectors, sessionSelectors, uiSelectors } from '@/core/stores';
import { setConversationFocusResolver, useObservableList, useSnowdrop } from '@/ui/hooks';
import { useConversationView } from '@/ui/features/conversation';
import {
  DropdownMenu,
  EmojiPickerPopover,
  IconButton,
  Slot,
  type MenuEntry,
} from '@/ui/primitives';
import { useChatController } from '../ChatController';
import { CustomEmojiPanel } from './CustomEmojiPanel';
import { AttachmentTray } from './AttachmentTray';
import { ComposerLinkPreview } from './ComposerLinkPreview';
import { PollCreateDialog } from './PollCreateDialog';
import { emptyPollDraft, type PollDraft } from './pollDraft';
import { ReplyBar } from './ReplyBar';
import { StickerPicker } from './StickerPicker';
import { TypingLine } from './TypingLine';
import { useAutocompleteField } from './useAutocompleteField';
import { useAutoGrow } from './useAutoGrow';
import { useComposer } from './useComposer';
import { useComposerSurface } from './useComposerSurface';
import { useTypeToFocus } from './useTypeToFocus';
import styles from './Composer.module.css';

/** The message composer for one conversation (remounted per conversation). */
export const Composer = memo(function Composer({
  conversationId,
}: {
  conversationId: ConversationId;
}) {
  const conversation = useConversationView(conversationId);
  if (!conversation) return null;
  return <ComposerInner key={conversationId} conversation={conversation} />;
});

function ComposerInner({ conversation }: { conversation: ConversationView }) {
  const app = useSnowdrop();
  const { stores, commands } = app;
  const chat = useChatController();
  const conversationId = conversation.id;
  const state = useComposer(conversation);
  const { text, setText } = state;
  const replyTo = useStore(stores.ui, uiSelectors.replyTo(conversationId));
  const enterToSend = useStore(stores.settings, (s) => s.behaviour.enterToSend);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [field, setField] = useState<HTMLDivElement | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  // Kept while the composer lives (closing the dialog doesn't lose a poll half typed).
  const [pollDraft, setPollDraft] = useState<PollDraft>(emptyPollDraft);
  // Polls are offered in groups only, as Signal Desktop does (a one-to-one poll is behind a flag there).
  const canPoll = conversation.kind === 'group' && app.send.capabilities.polls;
  // Only backends that can list (and so send) sticker packs get the button.
  const canSendStickers = app.backend.listStickerPacks !== undefined;
  const accessories = useObservableList(app.registries.composerAccessories);
  // An accessory may describe the field's state (Vim's mode) on this id (ComposerSlotProps).
  const descriptionId = useId();
  const syncCaret = useRef<() => void>(() => undefined);
  const suggestions = useComposerSurface({
    textarea,
    id: conversationId,
    setText,
    syncCaret: () => {
      syncCaret.current();
    },
    submit: () => {
      void state.submit();
    },
    escape: () => escape(),
  });

  /** Escape: cancel the reply, else mark read when the draft is empty (PLAN §4.6). */
  const escape = (): 'reply' | 'read' | 'none' => {
    const ui = stores.ui.getState();
    if (ui.replyTo[conversationId]) {
      ui.setReplyTo(conversationId, null);
      return 'reply';
    }
    // The field, not `text`: a key layer may have just edited it in this tick.
    const empty = (textarea.current?.value ?? text) === '' && state.attachments.length === 0;
    if (!empty) return 'none';
    void commands.execute(CoreCommand.MarkRead);
    return 'read';
  };

  const field_ = useAutocompleteField({
    textarea,
    anchor: field,
    text,
    setText,
    memberIds: conversation.memberIds,
    onMention: state.addMention,
    slash: true,
    suggestions,
  });
  const { replace } = field_;
  useEffect(() => {
    syncCaret.current = field_.syncCaret;
  });
  useAutoGrow(textarea, text);
  useTypeToFocus(textarea);

  const focus = useCallback(() => {
    textarea.current?.focus();
  }, []);
  useEffect(
    () => chat.registerComposer({ conversationId, addFiles: state.addFiles, focus }),
    [chat, conversationId, state.addFiles, focus],
  );
  // Navigating to this conversation (switcher, profile "Message") lands in the composer.
  useEffect(
    () => setConversationFocusResolver((id) => (id === conversationId ? textarea.current : null)),
    [conversationId],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (field_.onKeyDown(e)) return;
    if (e.key === 'Enter') {
      const sends = enterToSend ? !e.shiftKey : e.shiftKey || e.ctrlKey || e.metaKey;
      if (sends) {
        e.preventDefault();
        void state.submit();
      }
      return;
    }
    if (
      e.key === 'ArrowUp' &&
      text === '' &&
      state.attachments.length === 0 &&
      !e.shiftKey &&
      !e.altKey
    ) {
      const last = selfId
        ? messagesSelectors.lastOwn(conversationId, selfId)(stores.messages.getState())
        : undefined;
      if (last) {
        e.preventDefault();
        stores.ui.getState().setEditing({ conversationId, messageId: last.id });
        void chat.reveal(conversationId, last.id);
      }
      return;
    }
    if (e.key === 'Escape' && escape() !== 'none') e.preventDefault();
  };

  const attachEntries = (): MenuEntry[] => [
    {
      kind: 'item',
      id: 'upload',
      label: 'Upload a file',
      icon: <FileUp size={16} />,
      onSelect: () => fileInput.current?.click(),
    },
    {
      kind: 'item',
      id: 'poll',
      label: 'Poll',
      icon: <ChartBar size={16} />,
      onSelect: () => {
        setPollOpen(true);
      },
    },
  ];

  const placeholder =
    conversation.kind === 'group'
      ? `Message #${conversation.title}`
      : `Message @${conversation.title}`;

  return (
    <div className={styles.composer} data-snowdrop="composer" data-pane-title="message">
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      <div
        className={styles.shell}
        data-tui-bare
        data-reply={replyTo ? '' : undefined}
        data-link-preview={state.linkPreview.url ? '' : undefined}
      >
        {replyTo && (
          <ReplyBar
            conversationId={conversationId}
            messageId={replyTo}
            onCancel={() => {
              stores.ui.getState().setReplyTo(conversationId, null);
              focus();
            }}
          />
        )}
        <ComposerLinkPreview view={state.linkPreview} />
        <div className={styles.box} data-tui-bare ref={setField}>
          <AttachmentTray attachments={state.attachments} onRemove={state.removeAttachment} />
          <div className={styles.field}>
            {canPoll ? (
              <DropdownMenu entries={attachEntries} side="top" align="start" label="Add to message">
                <IconButton
                  label="Add attachment or poll"
                  icon={<CirclePlus />}
                  className={styles.button}
                />
              </DropdownMenu>
            ) : (
              <IconButton
                label="Upload a file"
                icon={<CirclePlus />}
                className={styles.button}
                onClick={() => fileInput.current?.click()}
              />
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              onChange={(e) => {
                state.addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
                focus();
              }}
            />
            <textarea
              ref={textarea}
              className={styles.input}
              rows={1}
              value={text}
              placeholder={placeholder}
              aria-label={placeholder}
              aria-describedby={accessories.length > 0 ? descriptionId : undefined}
              {...field_.inputProps}
              spellCheck
              onChange={(e) => {
                setText(e.target.value);
                field_.syncCaret();
              }}
              onSelect={field_.syncCaret}
              onKeyDown={onKeyDown}
              data-snowdrop="composer-input"
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                // Some webviews expose file clipboard entries only as items.
                // Prefer files when available: both lists can describe the same data.
                if (files.length === 0) {
                  for (const item of Array.from(e.clipboardData.items)) {
                    if (item.kind !== 'file') continue;
                    const file = item.getAsFile();
                    if (file) files.push(file);
                  }
                }
                if (files.length > 0) {
                  e.preventDefault();
                  state.addFiles(files);
                } else if (app.readClipboardFiles) {
                  const types = Array.from(e.clipboardData.types);
                  const plain = e.clipboardData.getData('text/plain');
                  // Keep ordinary text paste synchronous. Native-only images have
                  // no text; file managers advertise URI or copied-files formats.
                  const native =
                    !plain ||
                    types.includes('Files') ||
                    types.includes('x-special/gnome-copied-files') ||
                    (types.includes('text/uri-list') && /^(file:\/\/|\/)/u.test(plain.trim()));
                  if (!native) return;
                  e.preventDefault();
                  const source = e.currentTarget;
                  void app
                    .readClipboardFiles()
                    .then((copied) => {
                      // A slow clipboard owner must not attach to a different chat.
                      if (source.isConnected) state.addFiles(copied);
                    })
                    .catch((error: unknown) => {
                      if (source.isConnected)
                        state.setError(error instanceof Error ? error.message : String(error));
                    });
                }
              }}
            />
            <Slot
              name="composer.accessories"
              entries={accessories}
              props={{ conversationId, descriptionId }}
              className={styles.accessories}
            />
            {canSendStickers && (
              <StickerPicker
                conversationId={conversationId}
                open={stickersOpen}
                onOpenChange={setStickersOpen}
                onPick={(sticker) => {
                  void state.sendSticker(sticker);
                }}
                onCloseFocus={focus}
              >
                <IconButton
                  label="Stickers"
                  icon={<Sticker />}
                  className={styles.button}
                  active={stickersOpen}
                />
              </StickerPicker>
            )}
            <EmojiPickerPopover
              customContent={
                <CustomEmojiPanel
                  onSelect={(insert) => {
                    const el = textarea.current;
                    const start = el?.selectionStart ?? text.length;
                    const end = el?.selectionEnd ?? text.length;
                    replace(start, end, insert);
                    setEmojiOpen(false);
                    requestAnimationFrame(focus);
                  }}
                />
              }
              open={emojiOpen}
              onOpenChange={(open) => {
                setEmojiOpen(open);
                if (!open) requestAnimationFrame(focus);
              }}
              onSelect={(emoji) => {
                const el = textarea.current;
                const start = el?.selectionStart ?? text.length;
                const end = el?.selectionEnd ?? text.length;
                replace(start, end, emoji);
              }}
              side="top"
              align="end"
            >
              <IconButton
                label="Emoji"
                icon={<Smile />}
                className={styles.button}
                active={emojiOpen}
              />
            </EmojiPickerPopover>
          </div>
        </div>
      </div>
      {pollOpen && (
        <PollCreateDialog
          draft={pollDraft}
          onDraftChange={setPollDraft}
          onSend={(poll) => {
            setPollOpen(false);
            setPollDraft(emptyPollDraft());
            requestAnimationFrame(focus);
            void state.sendPoll(poll);
          }}
          onClose={() => {
            setPollOpen(false);
            requestAnimationFrame(focus);
          }}
        />
      )}
      {field_.popover}
      <TypingLine conversationId={conversationId} />
    </div>
  );
}
