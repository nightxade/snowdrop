import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { Message, Quote } from '@/core/domain';
import type { ConversationView } from '@/core/domain';
import { parseSlash } from '@/core/plugins';
import { contactsSelectors, localSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { useChatController } from '../ChatController';
import type { PendingAttachment } from './AttachmentTray';
import { addToken, encodeMentions, tokensInText, type MentionToken } from './mentionTokens';
import { useLinkPreview, type LinkPreviewView } from './useLinkPreview';

let attachmentSeq = 0;

/** The quote Signal clients show above a reply, attachment types included. */
export function quoteOf(m: Message): Quote {
  const quote: Quote = { authorId: m.authorId, sentAt: m.sentAt, text: m.body };
  if (m.ranges.length > 0) quote.ranges = m.ranges;
  if (m.attachments.length > 0)
    quote.attachments = m.attachments.map((a) => ({
      contentType: a.contentType,
      ...(a.fileName !== undefined ? { fileName: a.fileName } : {}),
    }));
  return quote;
}

export interface ComposerState {
  text: string;
  setText: (text: string) => void;
  tokens: MentionToken[];
  addMention: (token: MentionToken) => void;
  attachments: PendingAttachment[];
  addFiles: (files: readonly File[]) => void;
  removeAttachment: (id: string) => void;
  error: string | null;
  setError: (error: string | null) => void;
  linkPreview: LinkPreviewView;
  submit: () => Promise<void>;
}

/**
 * Composer state for one conversation: draft text (persisted per
 * conversation), mention tokens, pending attachments, slash commands and
 * sending (jumping back to the present first when the list is detached).
 */
export function useComposer(conversation: ConversationView): ComposerState {
  const app = useSnowdrop();
  const { stores, send, history, registries } = app;
  const chat = useChatController();
  const conversationId = conversation.id;
  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const [text, setTextState] = useState(() =>
    localSelectors.draft(conversationId)(stores.local.getState()),
  );
  const [tokens, setTokens] = useState<MentionToken[]>(() =>
    tokensInText(
      text,
      conversation.memberIds.flatMap((id) =>
        contacts[id] ? [{ id, name: contacts[id].name }] : [],
      ),
    ),
  );
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const linkPreviewsEnabled =
    useStore(stores.settings, (s) => s.behaviour.linkPreviews) && app.linkPreviewFetch !== null;
  const linkPreview = useLinkPreview(text, linkPreviewsEnabled);
  const latest = useRef(attachments);
  useEffect(() => {
    latest.current = attachments;
  }, [attachments]);
  // Previews are object URLs: release whatever is still pending on unmount.
  useEffect(
    () => () => {
      for (const a of latest.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      setError(null);
      stores.local.getState().setDraft(conversationId, next);
      void send.setTyping(conversationId, next.trim() !== '');
    },
    [stores, send, conversationId],
  );

  useEffect(
    () => () => {
      void send.setTyping(conversationId, false);
    },
    [send, conversationId],
  );

  const addFiles = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    const added = files.map((file): PendingAttachment => ({
      id: `att-${++attachmentSeq}`,
      file,
      ...(isPreviewable(file) ? { previewUrl: URL.createObjectURL(file) } : {}),
    }));
    setAttachments((current) => [...current, ...added]);
    // Measure images so the sent message reserves the right box before it loads.
    for (const a of added) {
      if (!a.previewUrl || typeof Image === 'undefined') continue;
      const img = new Image();
      img.onload = () => {
        setAttachments((current) =>
          current.map((x) =>
            x.id === a.id ? { ...x, width: img.naturalWidth, height: img.naturalHeight } : x,
          ),
        );
      };
      img.src = a.previewUrl;
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const gone = current.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return current.filter((a) => a.id !== id);
    });
  }, []);

  const clear = () => {
    setText('');
    setTokens([]);
    for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setAttachments([]);
    stores.ui.getState().setReplyTo(conversationId, null);
  };

  const deliver = async (raw: string, format?: 'markdown' | 'plain') => {
    const encoded = encodeMentions(raw, tokens);
    const replyId = stores.ui.getState().replyTo[conversationId];
    const replyTarget = replyId
      ? stores.messages.getState().windows[conversationId]?.byId[replyId]
      : undefined;
    const files = attachments.map((a) => ({
      fileName: a.file.name,
      contentType: a.file.type || 'application/octet-stream',
      data: a.file,
      // A fresh URL for the sent message (the tray's own is released below);
      // SendService releases it once the transport supplies its own.
      ...(a.previewUrl ? { previewUrl: URL.createObjectURL(a.file) } : {}),
      ...(a.width !== undefined && a.height !== undefined
        ? { width: a.width, height: a.height }
        : {}),
    }));
    // Same reasoning as the attachments above: a fresh object URL for the
    // sent message, independent of the composer card's own (which the
    // link-preview hook releases on its own schedule once `text` clears).
    const fetched = linkPreview.preview;
    const preview = fetched && {
      url: fetched.url,
      title: fetched.title,
      ...(fetched.description ? { description: fetched.description } : {}),
      ...(fetched.image
        ? {
            image: {
              contentType: fetched.image.contentType,
              data: fetched.image.data,
              previewUrl: URL.createObjectURL(fetched.image.data),
              ...(fetched.image.width !== undefined ? { width: fetched.image.width } : {}),
              ...(fetched.image.height !== undefined ? { height: fetched.image.height } : {}),
            },
          }
        : {}),
    };
    clear();
    // Sent messages only appear in a window anchored to the present.
    const w = stores.messages.getState().windows[conversationId];
    if (w && !w.anchoredToPresent) await history.jumpToPresent(conversationId);
    try {
      await send.send({
        conversationId,
        text: encoded.text,
        mentionIds: encoded.mentionIds,
        attachments: files,
        ...(replyTarget ? { quote: quoteOf(replyTarget) } : {}),
        ...(format ? { format } : {}),
        ...(preview ? { preview } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the message');
    }
    void chat.jumpToPresent();
  };

  const submit = async () => {
    const raw = text;
    if (raw.trim() === '' && attachments.length === 0) return;
    const slash = attachments.length === 0 ? parseSlash(raw) : null;
    const command = slash ? registries.findSlash(slash.name) : undefined;
    if (!slash || !command) {
      await deliver(raw);
      return;
    }
    try {
      const result = await command.execute(slash.args, { conversationId });
      switch (result.type) {
        case 'send':
          await deliver(result.text, result.format);
          break;
        case 'replace':
          setText(result.text);
          break;
        case 'error':
          setError(result.message);
          break;
        case 'done':
          clear();
          break;
      }
    } catch (e) {
      setError(`/${slash.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    text,
    setText,
    tokens,
    addMention: (token) => {
      setTokens((current) => addToken(current, token));
    },
    attachments,
    addFiles,
    removeAttachment,
    error,
    setError,
    linkPreview,
    submit,
  };
}

/** Raster images get a tray thumbnail and an optimistic preview (never SVG). */
function isPreviewable(file: File): boolean {
  return file.type.startsWith('image/') && file.type !== 'image/svg+xml';
}
