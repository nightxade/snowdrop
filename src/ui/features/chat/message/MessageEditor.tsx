import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import type { Message } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { addToken, encodeMentions, type MentionToken } from '../composer/mentionTokens';
import { useAutocompleteField } from '../composer/useAutocompleteField';
import { useAutoGrow } from '../composer/useAutoGrow';
import { toMarkdown } from '../lib/toMarkdown';
import { nameResolver } from './actions';
import styles from './MessageEditor.module.css';

/** Edit sessions that already took focus: a row virtualised away and back mustn't steal it again. */
const focusedSessions = new Set<string>();

/**
 * In-place editor inside a message row. The text lives in the ui store
 * (`editing.draft`), so scrolling the row out of the virtualised list and
 * back keeps it. Enter/Shift+Enter follow the send setting; Escape cancels
 * and returns focus to the row.
 */
export function MessageEditor({ message, onDone }: { message: Message; onDone: () => void }) {
  const app = useSnowdrop();
  const { stores } = app;
  const [initial] = useState(() => toMarkdown(message.body, message.ranges, nameResolver(app)));
  const draft = useStore(stores.ui, (s) => s.editing?.draft);
  const session = useStore(stores.ui, (s) => s.editing?.session ?? 0);
  const enterToSend = useStore(stores.settings, (s) => s.behaviour.enterToSend);
  const memberIds = useStore(
    stores.conversations,
    (s) => s.byId[message.conversationId]?.memberIds ?? EMPTY,
  );
  const text = draft ?? initial.text;
  const [tokens, setTokens] = useState<MentionToken[]>(initial.mentions);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  useAutoGrow(ref, text, '40vh');
  const setText = (next: string) => {
    stores.ui.getState().setEditDraft(next);
  };
  const ac = useAutocompleteField({
    textarea: ref,
    anchor: frame,
    text,
    setText,
    memberIds,
    onMention: (token) => {
      setTokens((current) => addToken(current, token));
    },
    slash: false,
  });

  useEffect(() => {
    const key = `${message.id}#${session}`;
    if (focusedSessions.has(key)) return;
    focusedSessions.add(key);
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [message.id, session]);

  const close = () => {
    stores.ui.getState().setEditing(null);
    onDone();
  };
  const save = () => {
    const encoded = encodeMentions(text, tokens);
    if (text.trim() !== '' && text !== initial.text) {
      void app.send.edit(message.conversationId, message.id, encoded.text, encoded.mentionIds);
    }
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ac.onKeyDown(e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter') {
      const saves = enterToSend ? !e.shiftKey : e.shiftKey || e.ctrlKey || e.metaKey;
      if (saves) {
        e.preventDefault();
        save();
      }
    }
  };

  return (
    <div className={styles.editor} ref={setFrame}>
      <textarea
        ref={ref}
        className={styles.input}
        value={text}
        rows={1}
        aria-label="Edit message"
        {...ac.inputProps}
        onChange={(e) => {
          setText(e.target.value);
          ac.syncCaret();
        }}
        onSelect={ac.syncCaret}
        onKeyDown={onKeyDown}
      />
      <p className={styles.hint}>
        escape to{' '}
        <button type="button" className={styles.link} onClick={close}>
          cancel
        </button>{' '}
        · {enterToSend ? 'enter' : 'shift+enter'} to{' '}
        <button type="button" className={styles.link} onClick={save}>
          save
        </button>
      </p>
      {ac.popover}
    </div>
  );
}

const EMPTY: readonly string[] = [];
