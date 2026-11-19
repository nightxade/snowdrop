import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationView } from '@/core/domain';
import { localSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { addToken, type MentionToken } from './mentionTokens';

/**
 * The composer's draft for one conversation: the text (persisted per conversation, and
 * announced as typing) and its mention tokens.
 */
export function useDraft(conversation: ConversationView, setError: (error: string | null) => void) {
  const { stores, send } = useSnowdrop();
  const conversationId = conversation.id;
  const [text, setTextState] = useState(() =>
    localSelectors.draft(conversationId)(stores.local.getState()),
  );
  // Only the mentions picked from the list are mentions: they are kept with the draft, never
  // worked out again from the text (a typed "@Name" is plain text).
  const [tokens, setTokensState] = useState<MentionToken[]>(() => [
    ...(localSelectors.draftMentions(conversationId)(stores.local.getState()) ?? []),
  ]);
  const setTokens = useCallback(
    (next: MentionToken[]) => {
      setTokensState(next);
      stores.local.getState().setDraftMentions(conversationId, next);
    },
    [stores, conversationId],
  );
  // What the field holds right now, readable after an await (a failed send puts the draft
  // back only if nothing has been typed meanwhile).
  const currentText = useRef(text);

  const setText = useCallback(
    (next: string) => {
      currentText.current = next;
      setTextState(next);
      setError(null);
      stores.local.getState().setDraft(conversationId, next);
      // Nothing left to mention: a mention picked earlier must not turn a retyped name into one.
      if (next === '') setTokens([]);
      void send.setTyping(conversationId, next.trim() !== '');
    },
    [stores, send, conversationId, setError, setTokens],
  );

  useEffect(
    () => () => {
      void send.setTyping(conversationId, false);
    },
    [send, conversationId],
  );

  /** Puts back the words a send that did not go out took (never over newer input). */
  const restoreDraft = (draft: { text: string; tokens: MentionToken[] }) => {
    if (currentText.current !== '' || draft.text === '') return;
    // Not `setText`: that would also clear the error that says why it came back.
    currentText.current = draft.text;
    setTextState(draft.text);
    stores.local.getState().setDraft(conversationId, draft.text);
    setTokens(draft.tokens);
  };

  return {
    text,
    setText,
    tokens,
    setTokens,
    addMention: (token: MentionToken) => {
      setTokens(addToken(tokens, token));
    },
    restoreDraft,
  };
}
