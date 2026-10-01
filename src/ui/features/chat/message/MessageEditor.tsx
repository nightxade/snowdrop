import { useRef, useState, type KeyboardEvent } from 'react';
import type { Message } from '@/core/domain';
import { useHearth } from '@/ui/hooks';
import { useChatController } from '../ChatController';
import { encodeMentions } from '../composer/mentionTokens';
import { replaceRange, useAutoGrow } from '../composer/useAutoGrow';
import { wrapSelection } from '../composer/formatting';
import { toMarkdown } from '../lib/toMarkdown';
import { nameResolver } from './actions';
import styles from './MessageEditor.module.css';

/** In-place editor inside a message row: Enter saves, Escape cancels. */
export function MessageEditor({ message }: { message: Message }) {
  const app = useHearth();
  const chat = useChatController();
  const [initial] = useState(() => toMarkdown(message.body, message.ranges, nameResolver(app)));
  const [text, setText] = useState(initial.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, text, '40vh');

  const close = () => {
    app.stores.ui.getState().setEditing(null);
    chat.focusComposer();
  };
  const save = () => {
    const encoded = encodeMentions(text, initial.mentions);
    if (text.trim() !== '' && text !== initial.text) {
      void app.send.edit(message.conversationId, message.id, encoded.text, encoded.mentionIds);
    }
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (
      wrapSelection(e, (start, end, replacement, s1, s2) => {
        setText(replaceRange(el, start, end, replacement, s1, s2));
      })
    ) {
      e.preventDefault();
    }
  };

  return (
    <div className={styles.editor}>
      <textarea
        ref={ref}
        className={styles.input}
        value={text}
        rows={1}
        aria-label="Edit message"
        autoFocus
        onFocus={(e) => {
          const end = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(end, end);
        }}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <p className={styles.hint}>
        escape to{' '}
        <button type="button" className={styles.link} onClick={close}>
          cancel
        </button>{' '}
        · enter to{' '}
        <button type="button" className={styles.link} onClick={save}>
          save
        </button>
      </p>
    </div>
  );
}
