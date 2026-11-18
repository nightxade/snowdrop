import { describeSendFailure } from '@/ui/lib/connectionErrors';
import { useRef, useState } from 'react';
import {
  isPendingMessageId,
  pollPreviewText,
  type Message,
  type Quote,
  type StickerContent,
} from '@/core/domain';
import type { ConversationView } from '@/core/domain';
import type { OutgoingPoll } from '@/core/backend';
import { parseSlash } from '@/core/plugins';
import { useEffectivePrivacy, useSnowdrop } from '@/ui/hooks';
import { useChatController } from '../ChatController';
import type { PendingAttachment } from './AttachmentTray';
import { encodeMentions, type MentionToken } from './mentionTokens';
import { useAttachments, voicePending } from './useAttachments';
import { useDraft } from './useDraft';
import { replyTargetOf, useReplyGuard } from './useReplyTarget';
import { useLinkPreview, type LinkPreviewView } from './useLinkPreview';
import type { VoiceRecording } from '../voice/recorder';
import { rememberWaveform } from '../voice/waveformCache';

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
  const [error, setError] = useState<string | null>(null);
  const { text, setText, tokens, setTokens, addMention, restoreDraft } = useDraft(
    conversation,
    setError,
  );
  const {
    attachments,
    addFiles,
    removeAttachment,
    addVoiceNote,
    clearAttachments,
    restoreAttachments,
  } = useAttachments(setError);
  // The phone's link-preview setting wins when known (and nothing is fetched
  // until it has been read).
  const linkPreviewsEnabled = useEffectivePrivacy().linkPreviews && app.linkPreviewFetch !== null;
  const linkPreview = useLinkPreview(text, linkPreviewsEnabled);
  useReplyGuard(conversationId);

  const clear = () => {
    setText('');
    setTokens([]);
    clearAttachments();
    stores.ui.getState().setReplyTo(conversationId, null);
  };

  /** The unsent messages (sending or failed) the conversation shows right now. */
  const pendingIds = (): Set<string> =>
    new Set(
      (stores.messages.getState().windows[conversationId]?.ids ?? []).filter((id) =>
        isPendingMessageId(id),
      ),
    );

  /** Puts a spent reply back (never over a reply picked meanwhile). */
  const restoreReply = (replyId: Message['id'] | undefined, target: Message | undefined) => {
    if (replyId && stores.ui.getState().replyTo[conversationId] === undefined)
      stores.ui.getState().setReplyTo(conversationId, replyId, target);
  };

  /**
   * The message being replied to, or undefined with no reply. When a reply is up but its message
   * is gone (deleted since), the reply is cancelled, nothing is sent and the draft stays.
   */
  const takeReply = (): { id: Message['id']; target: Message } | undefined | 'gone' => {
    const id = stores.ui.getState().replyTo[conversationId];
    if (!id) return undefined;
    const target = replyTargetOf(stores, conversationId);
    if (target) return { id, target };
    stores.ui.getState().setReplyTo(conversationId, null);
    setError('The message you were replying to is gone. Your reply was cancelled.');
    return 'gone';
  };

  /**
   * Runs a send once the list shows the present (a send only appears there), reports a failure
   * in the composer, and scrolls to the end. `notSent` is true when nothing went out and no
   * failed row was staged for it, so what the send took from the composer should come back
   * (a staged row has Retry; a restored draft would send it twice).
   */
  const sendInPresent = async <T>(
    run: () => Promise<T>,
    failure: string,
  ): Promise<{ result: T | typeof FAILED; notSent: boolean }> => {
    let before = new Set<string>();
    let result: T | typeof FAILED;
    try {
      const w = stores.messages.getState().windows[conversationId];
      if (w && !w.anchoredToPresent) await history.jumpToPresent(conversationId);
      before = pendingIds();
      result = await run();
    } catch (e) {
      setError(describeSendFailure(e, failure));
      result = FAILED;
    } finally {
      void chat.jumpToPresent();
    }
    const staged = [...pendingIds()].some((id) => !before.has(id));
    return { result, notSent: (result === FAILED || result === null) && !staged };
  };

  const deliver = async (
    raw: string,
    format?: 'markdown' | 'plain',
    outgoing: readonly PendingAttachment[] = attachments,
  ) => {
    const encoded = encodeMentions(raw, tokens);
    const reply = takeReply();
    if (reply === 'gone') return;
    const replyId = reply?.id;
    const replyTarget = reply?.target;
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
    const draft = { text, tokens, attachments: outgoing };
    clear();
    const { notSent } = await sendInPresent(
      () =>
        send.send({
          conversationId,
          text: encoded.text,
          mentionIds: encoded.mentionIds,
          attachments: files,
          ...(replyTarget ? { quote: quoteOf(replyTarget) } : {}),
          ...(format ? { format } : {}),
          ...(preview ? { preview } : {}),
        }),
      'Could not send the message',
    );
    // Not sent (it threw, or a plugin emptied it): the user's words, files and reply come back.
    if (notSent) {
      restoreDraft(draft);
      restoreAttachments(draft.attachments);
      restoreReply(replyId, replyTarget);
    }
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
    const reply = takeReply();
    if (reply === 'gone') return;
    const replyId = reply?.id;
    const replyTarget = reply?.target;
    // The draft (and any attachments) stay as they are; only the reply is spent.
    if (replyId) stores.ui.getState().setReplyTo(conversationId, null);
    setError(null);
    stores.local.getState().noteStickerSent(sticker);
    const { notSent } = await sendInPresent(
      () =>
        send.sendSticker({
          conversationId,
          sticker,
          ...(replyTarget ? { quote: quoteOf(replyTarget) } : {}),
        }),
      'Could not send the sticker',
    );
    if (notSent) restoreReply(replyId, replyTarget);
  };

  const sendPoll = async (poll: OutgoingPoll) => {
    setError(null);
    // Nothing is taken from the composer, so nothing comes back.
    const { result } = await sendInPresent(
      () => send.sendPoll({ conversationId, poll }),
      'Could not send the poll',
    );
    if (result === null) setError("This connection can't send polls.");
  };

  return {
    text,
    setText,
    tokens,
    addMention,
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
