import { describeSendFailure } from '@/ui/lib/connectionErrors';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  attachmentProblem,
  isPendingMessageId,
  rejectedFilesMessage,
  type AttachmentProblem,
  pollPreviewText,
  type Message,
  type Quote,
  type StickerContent,
} from '@/core/domain';
import type { ConversationView } from '@/core/domain';
import type { OutgoingPoll } from '@/core/backend';
import { parseSlash } from '@/core/plugins';
import { contactsSelectors, localSelectors } from '@/core/stores';
import { useEffectivePrivacy, useSnowdrop } from '@/ui/hooks';
import { useChatController } from '../ChatController';
import type { PendingAttachment } from './AttachmentTray';
import { addToken, encodeMentions, tokensInText, type MentionToken } from './mentionTokens';
import { useLinkPreview, type LinkPreviewView } from './useLinkPreview';
import type { VoiceRecording } from '../voice/recorder';
import { rememberWaveform } from '../voice/waveformCache';

let attachmentSeq = 0;

/** The quote Signal clients show above a reply, attachment types included. */
export function quoteOf(m: Message): Quote {
  // A poll has no body; it quotes as its question, like Signal Desktop's own quote of one.
  const text = m.body === '' && m.poll ? pollPreviewText(m.poll) : m.body;
  const quote: Quote = { authorId: m.authorId, sentAt: m.sentAt, text };
  if (m.ranges.length > 0) quote.ranges = m.ranges;
  if (m.attachments.length > 0)
    quote.attachments = m.attachments.map((a) => ({
      contentType: a.contentType,
      ...(a.fileName !== undefined ? { fileName: a.fileName } : {}),
    }));
  if (m.sticker) {
    // Our own quote preview (QuoteHeader) renders this directly as
    // "Sticker"; `attachments` is what carries the reply over the wire, so
    // other Signal clients still show a sensible (if generic) quote rather
    // than an empty one.
    quote.sticker = { ...(m.sticker.emoji ? { emoji: m.sticker.emoji } : {}) };
    quote.attachments = [{ contentType: 'image/webp' }];
  }
  return quote;
}

export interface ComposerState {
  text: string;
  setText: (text: string) => void;
  tokens: MentionToken[];
  addMention: (token: MentionToken) => void;
  attachments: PendingAttachment[];
  addFiles: (files: readonly File[]) => void;
  /** Keeps a recorded voice note in the composer to be listened to, then sent or dropped. */
  addVoiceNote: (recording: VoiceRecording) => void;
  /** Sends a recorded voice note at once (the reply, if any, goes with it). */
  sendVoiceNote: (recording: VoiceRecording) => Promise<void>;
  removeAttachment: (id: string) => void;
  error: string | null;
  setError: (error: string | null) => void;
  linkPreview: LinkPreviewView;
  submit: () => Promise<void>;
  /** Sends a sticker at once (no draft), as a reply when a reply is active. */
  sendSticker: (sticker: StickerContent) => Promise<void>;
  /** Sends a poll at once (the draft text and any reply are left as they are). */
  sendPoll: (poll: OutgoingPoll) => Promise<void>;
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
  // The phone's link-preview setting wins when known (and nothing is fetched
  // until it has been read).
  const linkPreviewsEnabled = useEffectivePrivacy().linkPreviews && app.linkPreviewFetch !== null;
  const linkPreview = useLinkPreview(text, linkPreviewsEnabled);
  const latest = useRef(attachments);
  useEffect(() => {
    latest.current = attachments;
  }, [attachments]);
  // What the field holds right now, readable after an await (a failed send puts the draft
  // back only if nothing has been typed meanwhile).
  const currentText = useRef(text);
  // Previews are object URLs: release whatever is still pending on unmount.
  useEffect(
    () => () => {
      for (const a of latest.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  const setText = useCallback(
    (next: string) => {
      currentText.current = next;
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
    // Signal sends a voice message alone.
    if (latest.current.some((a) => a.voiceNote)) {
      setError(VOICE_ALONE);
      return;
    }
    // A file that can never be sent never becomes a pending attachment; the rest of a drop stays.
    const rejected: { name: string; problem: AttachmentProblem }[] = [];
    const accepted = files.filter((file) => {
      const problem = attachmentProblem(file);
      if (problem) rejected.push({ name: file.name, problem });
      return problem === null;
    });
    if (rejected.length > 0) setError(rejectedFilesMessage(rejected));
    if (accepted.length === 0) return;
    const added = accepted.map((file): PendingAttachment => ({
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
    latest.current = [];
    setAttachments([]);
    stores.ui.getState().setReplyTo(conversationId, null);
  };

  /** The unsent messages (sending or failed) the conversation shows right now. */
  const pendingIds = (): Set<string> =>
    new Set(
      (stores.messages.getState().windows[conversationId]?.ids ?? []).filter((id) =>
        isPendingMessageId(id),
      ),
    );

  /** Puts back what a send that did not go out took from the composer (never over newer input). */
  const restore = (draft: {
    text: string;
    tokens: MentionToken[];
    attachments: readonly PendingAttachment[];
    replyId: Message['id'] | undefined;
  }) => {
    if (currentText.current === '' && draft.text !== '') {
      // Not `setText`: that would also clear the error that says why it came back.
      currentText.current = draft.text;
      setTextState(draft.text);
      stores.local.getState().setDraft(conversationId, draft.text);
      setTokens(draft.tokens);
    }
    if (latest.current.length === 0 && draft.attachments.length > 0) {
      // The files are still held; their previews were released with the tray, so make new ones.
      const back = draft.attachments.map((a) => ({
        ...a,
        ...(a.previewUrl !== undefined || a.voiceNote === true
          ? { previewUrl: URL.createObjectURL(a.file) }
          : {}),
      }));
      latest.current = back;
      setAttachments(back);
    }
    if (draft.replyId && stores.ui.getState().replyTo[conversationId] === undefined)
      stores.ui.getState().setReplyTo(conversationId, draft.replyId);
  };

  /**
   * Runs a send once the list shows the present (a send only appears there), reports a failure
   * in the composer, and scrolls to the end. Resolves with the send's result, or `FAILED`.
   */
  const sendInPresent = async <T>(run: () => Promise<T>, failure: string): Promise<T | Failed> => {
    try {
      const w = stores.messages.getState().windows[conversationId];
      if (w && !w.anchoredToPresent) await history.jumpToPresent(conversationId);
      return await run();
    } catch (e) {
      setError(describeSendFailure(e, failure));
      return FAILED;
    } finally {
      void chat.jumpToPresent();
    }
  };

  const addVoiceNote = (recording: VoiceRecording) => {
    const pending = voicePending(recording);
    setAttachments([{ ...pending, previewUrl: URL.createObjectURL(pending.file) }]);
  };

  const deliver = async (
    raw: string,
    format?: 'markdown' | 'plain',
    outgoing: readonly PendingAttachment[] = attachments,
  ) => {
    const encoded = encodeMentions(raw, tokens);
    const replyId = stores.ui.getState().replyTo[conversationId];
    const replyTarget = replyId
      ? stores.messages.getState().windows[conversationId]?.byId[replyId]
      : undefined;
    const files = outgoing.map((a) => {
      // A fresh URL for the sent message (the tray's own is released below);
      // SendService releases it once the transport supplies its own.
      const previewUrl =
        a.previewUrl !== undefined || a.voiceNote === true
          ? URL.createObjectURL(a.file)
          : undefined;
      // The recorder already knows the waveform: the sent note needn't decode its own file.
      if (a.voiceNote && previewUrl && a.levels && a.duration !== undefined)
        rememberWaveform([`url:${previewUrl}`], { levels: a.levels, duration: a.duration });
      return {
        fileName: a.file.name,
        contentType: a.file.type || 'application/octet-stream',
        data: a.file,
        ...(previewUrl ? { previewUrl } : {}),
        ...(a.voiceNote ? { voiceNote: true } : {}),
        ...(a.width !== undefined && a.height !== undefined
          ? { width: a.width, height: a.height }
          : {}),
      };
    });
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
    const draft = { text, tokens, attachments: outgoing, replyId };
    clear();
    let before = new Set<string>();
    const sent = await sendInPresent(() => {
      before = pendingIds();
      return send.send({
        conversationId,
        text: encoded.text,
        mentionIds: encoded.mentionIds,
        attachments: files,
        ...(replyTarget ? { quote: quoteOf(replyTarget) } : {}),
        ...(format ? { format } : {}),
        ...(preview ? { preview } : {}),
      });
    }, 'Could not send the message');
    // Not sent (it threw, or a plugin emptied it): the user's words and files come back. Unless
    // the message was already staged: its failed row, with Retry, is the way back then, and a
    // restored draft would send it twice.
    const staged = [...pendingIds()].some((id) => !before.has(id));
    if ((sent === FAILED || sent === null) && !staged) restore(draft);
  };

  const executing = useRef(false);
  const submit = async () => {
    const raw = text;
    if (raw.trim() === '' && attachments.length === 0) return;
    const slash = attachments.length === 0 ? parseSlash(raw) : null;
    const command = slash ? registries.findSlash(slash.name) : undefined;
    if (!slash || !command) {
      await deliver(raw);
      return;
    }
    // A held Enter must not run the command again while it is still running.
    if (executing.current) return;
    executing.current = true;
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
      setError(`/${slash.name} failed: ${describeSendFailure(e)}`);
    } finally {
      executing.current = false;
    }
  };

  const sendVoiceNote = async (recording: VoiceRecording) => {
    await deliver('', undefined, [voicePending(recording)]);
  };

  const sendSticker = async (sticker: StickerContent) => {
    const replyId = stores.ui.getState().replyTo[conversationId];
    const replyTarget = replyId
      ? stores.messages.getState().windows[conversationId]?.byId[replyId]
      : undefined;
    // The draft (and any attachments) stay as they are; only the reply is spent.
    if (replyId) stores.ui.getState().setReplyTo(conversationId, null);
    setError(null);
    stores.local.getState().noteStickerSent(sticker);
    await sendInPresent(
      () =>
        send.sendSticker({
          conversationId,
          sticker,
          ...(replyTarget ? { quote: quoteOf(replyTarget) } : {}),
        }),
      'Could not send the sticker',
    );
  };

  const sendPoll = async (poll: OutgoingPoll) => {
    setError(null);
    const nonce = await sendInPresent(
      () => send.sendPoll({ conversationId, poll }),
      'Could not send the poll',
    );
    if (nonce === null) setError("This connection can't send polls.");
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
    addVoiceNote,
    sendVoiceNote,
    removeAttachment,
    error,
    setError,
    linkPreview,
    submit,
    sendSticker,
    sendPoll,
  };
}

/** What `sendInPresent` resolves with when the send threw (the error is already shown). */
const FAILED = Symbol('failed');
type Failed = typeof FAILED;

const VOICE_ALONE = 'A voice message must have only one attachment.';

let voiceSeq = 0;

/** A recording as a composer attachment (no preview URL yet: only a draft needs one). */
function voicePending(recording: VoiceRecording): PendingAttachment {
  return {
    id: `voice-${++voiceSeq}`,
    file: new File([recording.blob], 'voice-note.mp3', { type: 'audio/mpeg' }),
    voiceNote: true,
    levels: recording.waveform,
    duration: recording.durationSeconds,
  };
}

/** Raster images get a tray thumbnail and an optimistic preview (never SVG). */
function isPreviewable(file: File): boolean {
  return file.type.startsWith('image/') && file.type !== 'image/svg+xml';
}
