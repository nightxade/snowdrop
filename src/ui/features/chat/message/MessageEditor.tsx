import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { editRefusal, type Message } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { useEffectivePrivacy, useSnowdrop } from '@/ui/hooks';
import { addToken, encodeMentions, type MentionToken } from '../composer/mentionTokens';
import { useAutocompleteField } from '../composer/useAutocompleteField';
import { ComposerLinkPreview } from '../composer/ComposerLinkPreview';
import { useAutoGrow } from '../composer/useAutoGrow';
import { useLinkPreview } from '../composer/useLinkPreview';
import { toMarkdown } from '../lib/toMarkdown';
import { nameResolver } from './actions';
import styles from './MessageEditor.module.css';

/**
 * The edit session that already took focus: a row virtualised away and back
 * mustn't steal it again. Only one edit is open at a time, so one key does.
 */
let focusedSession: string | null = null;

/**
 * In-place editor inside a message row. The text and the mentions picked
 * live in the ui store (`editing.draft`, `editing.mentions`), so scrolling the
 * row out of the virtualised list and back keeps them. The message's link
 * preview goes with the edit: it stays while its link does, a new link gets
 * a freshly fetched one, and removing the link (or the card) drops it.
 * Enter/Shift+Enter follow the send setting; Escape cancels and returns
 * focus to the row. A save that can't go through keeps the editor, and the
 * text, open with the reason.
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
  const picked = useStore(stores.ui, (s) => s.editing?.mentions);
  const tokens: readonly MentionToken[] = picked ?? initial.mentions;
  // A message with files carries no preview (the edit couldn't send both).
  // Nothing is fetched or shown for it either: the card would promise what is never sent.
  const hasFiles = message.attachments.length > 0;
  const existing = hasFiles ? undefined : message.previews?.[0];
  const linkPreviewsEnabled =
    useEffectivePrivacy().linkPreviews && app.linkPreviewFetch !== null && !hasFiles;
  const dismissedPreview = useStore(stores.ui, (s) => s.editing?.dismissedPreview);
  const dismissal = useMemo(
    () => ({
      url: dismissedPreview,
      dismiss: (url: string) => {
        stores.ui.getState().dismissEditPreview(url);
      },
    }),
    [dismissedPreview, stores],
  );
  const linkPreview = useLinkPreview(text, linkPreviewsEnabled, existing, dismissal);
  const [problem, setProblem] = useState<string | null>(null);
  const saving = useRef(false);
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
    conversationId: message.conversationId,
    onMention: (token) => {
      const ui = stores.ui.getState();
      ui.setEditMentions(addToken(ui.editing?.mentions ?? initial.mentions, token));
    },
    slash: false,
  });

  useEffect(() => {
    const key = `${message.id}#${session}`;
    if (focusedSession === key) return;
    focusedSession = key;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [message.id, session]);

  const close = () => {
    stores.ui.getState().setEditing(null);
    onDone();
  };
  const save = async () => {
    if (saving.current) return;
    const encoded = encodeMentions(text, tokens);
    if (text.trim() === '' || text === initial.text) {
      close();
      return;
    }
    // The window may have closed (or the message changed) while this was open.
    const current = messagesSelectors.message(
      message.conversationId,
      message.id,
    )(stores.messages.getState());
    const refusal =
      current &&
      editRefusal(current, {
        selfId: stores.session.getState().self?.id ?? null,
        now: Date.now(),
      });
    if (refusal) {
      setProblem(refusal);
      return;
    }
    saving.current = true;
    setProblem(null);
    // The shown card decides: a fetched one is sent, the message's own is left to go again,
    // and none (removed, link gone, still loading) drops it.
    const outgoing = linkPreview.preview ?? (linkPreview.kept ? undefined : null);
    let saved: boolean;
    try {
      saved = await app.send.edit(
        message.conversationId,
        message.id,
        encoded.text,
        encoded.mentionIds,
        outgoing,
      );
    } catch {
      saved = false;
    }
    saving.current = false;
    if (saved) close();
    else setProblem("Couldn't save the edit. Your text is still here; try again, or cancel.");
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
        void save();
      }
    }
  };

  return (
    <div className={styles.editor} ref={setFrame}>
      {linkPreview.url && (
        <div className={styles.preview}>
          <ComposerLinkPreview view={linkPreview} />
        </div>
      )}
      <textarea
        ref={ref}
        className={styles.input}
        value={text}
        rows={1}
        aria-label="Edit message"
        data-owns-escape=""
        {...ac.inputProps}
        onChange={(e) => {
          setText(e.target.value);
          ac.syncCaret();
        }}
        onSelect={ac.syncCaret}
        onKeyDown={onKeyDown}
      />
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      <p className={styles.hint}>
        escape to{' '}
        <button type="button" className={styles.link} onClick={close}>
          cancel
        </button>{' '}
        · {enterToSend ? 'enter' : 'shift+enter'} to{' '}
        <button type="button" className={styles.link} onClick={() => void save()}>
          save
        </button>
      </p>
      {ac.popover}
    </div>
  );
}

const EMPTY: readonly string[] = [];
