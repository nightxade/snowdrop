import { CirclePlus, Smile } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import type { ConversationId, ConversationView } from '@/core/domain';
import { messagesSelectors, sessionSelectors, uiSelectors } from '@/core/stores';
import { setConversationFocusResolver, useHearth } from '@/ui/hooks';
import { useConversationView } from '@/ui/features/conversation';
import { EmojiPickerPopover, IconButton } from '@/ui/primitives';
import { useChatController } from '../ChatController';
import { AutocompletePopover, optionId } from './AutocompletePopover';
import { AttachmentTray } from './AttachmentTray';
import { ReplyBar } from './ReplyBar';
import { TypingLine } from './TypingLine';
import { wrapSelection } from './formatting';
import { useAutocomplete } from './useAutocomplete';
import { replaceRange, useAutoGrow } from './useAutoGrow';
import { useComposer } from './useComposer';
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
  const app = useHearth();
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
  const [caret, setCaret] = useState(text.length);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const listId = useId();
  const auto = useAutocomplete(text, caret, conversation);
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

  const syncCaret = () => {
    const el = textarea.current;
    if (el) setCaret(el.selectionEnd);
  };

  const replace = (
    start: number,
    end: number,
    insert: string,
    selStart?: number,
    selEnd?: number,
  ) => {
    const el = textarea.current;
    if (!el) return;
    const next = replaceRange(el, start, end, insert, selStart, selEnd);
    setText(next);
    setCaret(el.selectionEnd);
  };

  const accept = (index: number) => {
    const s = auto.suggestions[index];
    const t = auto.trigger;
    if (!s || !t) return;
    if (s.kind === 'mention') state.addMention(s.token);
    // Slash commands keep whatever arguments were typed after the name.
    const space = text.search(/\s/u);
    const end = s.kind === 'slash' ? (space === -1 ? text.length : space + 1) : t.end;
    replace(t.start, end, s.insert);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (auto.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        auto.move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        accept(auto.active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        auto.dismiss();
        return;
      }
    }
    if (wrapSelection(e, replace)) {
      e.preventDefault();
      return;
    }
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
    if (e.key === 'Escape') {
      if (replyTo) {
        e.preventDefault();
        stores.ui.getState().setReplyTo(conversationId, null);
      } else if (text === '' && state.attachments.length === 0) {
        e.preventDefault();
        void commands.execute(CoreCommand.MarkRead);
      }
    }
  };

  const placeholder =
    conversation.kind === 'group'
      ? `Message #${conversation.title}`
      : `Message @${conversation.title}`;

  return (
    <div className={styles.composer} data-hearth="composer">
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      <div className={styles.shell} data-reply={replyTo ? '' : undefined}>
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
        <div className={styles.box} ref={setField}>
          <AttachmentTray attachments={state.attachments} onRemove={state.removeAttachment} />
          <div className={styles.field}>
            <IconButton
              label="Upload a file"
              icon={<CirclePlus />}
              className={styles.button}
              onClick={() => fileInput.current?.click()}
            />
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
              aria-autocomplete="list"
              aria-controls={auto.open ? listId : undefined}
              aria-activedescendant={auto.open ? optionId(listId, auto.active) : undefined}
              spellCheck
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionEnd);
              }}
              onSelect={syncCaret}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length > 0) {
                  e.preventDefault();
                  state.addFiles(files);
                }
              }}
            />
            <EmojiPickerPopover
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
      {auto.open && auto.trigger && (
        <AutocompletePopover
          id={listId}
          anchor={field}
          kind={auto.trigger.kind}
          query={auto.trigger.query}
          suggestions={auto.suggestions}
          active={auto.active}
          onHover={auto.setActive}
          onPick={accept}
        />
      )}
      <TypingLine conversationId={conversationId} />
    </div>
  );
}
