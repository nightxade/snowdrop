/**
 * What the forward dialog works from, kept out of the components so the
 * rules are unit-tested: which chats can be picked (and why one can't), how a
 * search ranks them, and what of a message is carried along.
 *
 * What is carried follows Signal Desktop's forward: the text with its styles
 * (a mention turns into plain `@name` text), every attachment (re-sent from
 * its bytes, a voice message staying one), a sticker on its own, and the
 * message's link preview. What is dropped: the quote it replied to, its
 * reactions and edit history, delivered custom emoji, and anything about who
 * first sent it.
 */
import {
  bodyToPlainText,
  canSendToGroup,
  directConversationId,
  escapeMarkdown,
  fuzzyMatch,
  isConversationBlocked,
  isForwardEditable,
  isVoiceNote,
  type Attachment,
  type Contact,
  type ConversationId,
  type ConversationView,
  type LinkPreview,
  type Message,
  type MessageId,
  type MessageRequestState,
  type StickerContent,
} from '@/core/domain';
import { toMarkdown } from '@/ui/features/chat';

export interface ForwardTarget {
  id: ConversationId;
  title: string;
  kind: 'direct' | 'group';
  /** The conversation, when there is one; a contact without a chat yet has none. */
  view?: ConversationView;
  /** The person to start the chat with, for a target that has no conversation yet. */
  contact?: Contact;
  number?: string;
  /** "Direct message", "12 members", "Archived"… under the name. */
  meta: string;
  /** Why the user can't send here (the row stays, so it can be explained). */
  unavailable?: string;
  /** Not accepted yet: forwarding into it accepts it. */
  request: boolean;
  archived: boolean;
}

export interface ForwardTargetSources {
  /** Every conversation, most recent first. */
  views: readonly ConversationView[];
  contacts: Readonly<Record<string, Contact>>;
  /** Contacts a message can go to (`composableContacts`). */
  composable: readonly Contact[];
  self: Contact | null;
  requestState: (view: ConversationView) => MessageRequestState;
}

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

function peerOf(view: ConversationView, selfId: string | null): string | undefined {
  return view.memberIds.find((id) => id !== selfId) ?? view.memberIds[0];
}

/**
 * Every chat a message can be forwarded to: the conversations (unarchived
 * first, each in recency order), then contacts with no chat yet. Chats the
 * user can't write to are listed with the reason rather than hidden.
 */
export function buildForwardTargets(sources: ForwardTargetSources): ForwardTarget[] {
  const { views, contacts, composable, self, requestState } = sources;
  const selfId = self?.id ?? null;
  const known = new Set<string>();
  const out: ForwardTarget[] = [];
  for (const view of views) {
    known.add(view.id);
    const request = requestState(view) === 'request';
    const target: ForwardTarget = {
      id: view.id,
      title: view.title,
      kind: view.kind,
      view,
      meta: '',
      request,
      archived: view.archived,
    };
    if (view.kind === 'group') {
      target.meta = view.left ? 'Left group' : plural(view.memberIds.length, 'member', 'members');
      if (view.left) target.unavailable = 'You left this group';
      else if (isConversationBlocked(view, (id) => contacts[id])) target.unavailable = 'Blocked';
      else if (!canSendToGroup(view, selfId)) target.unavailable = 'Only admins can send here';
    } else {
      const peerId = peerOf(view, selfId);
      const peer = peerId ? contacts[peerId] : undefined;
      target.meta = peer?.isSelf === true || peerId === selfId ? '' : 'Direct message';
      if (peer?.number) target.number = peer.number;
      if (peer) target.contact = peer;
      if (isConversationBlocked(view, (id) => contacts[id])) target.unavailable = 'Blocked';
      else if (peer?.unregistered) target.unavailable = 'No longer on Signal';
    }
    if (view.archived) target.meta = `${target.meta} · Archived`;
    out.push(target);
  }
  // Unarchived chats first; recency order is kept inside each half.
  const ordered = [...out.filter((t) => !t.archived), ...out.filter((t) => t.archived)];
  const fresh: ForwardTarget[] = [];
  if (self && !known.has(directConversationId(self.id))) {
    fresh.push({
      id: directConversationId(self.id),
      title: 'Note to Self',
      kind: 'direct',
      contact: self,
      meta: '',
      request: false,
      archived: false,
    });
  }
  for (const contact of composable) {
    const id = directConversationId(contact.id);
    if (known.has(id)) continue;
    fresh.push({
      id,
      title: contact.name,
      kind: 'direct',
      contact,
      ...(contact.number ? { number: contact.number } : {}),
      meta: 'Contact',
      request: false,
      archived: false,
    });
  }
  return [...ordered, ...fresh];
}

export interface TargetMatch {
  target: ForwardTarget;
  /** Matched UTF-16 positions in `target.title`, for highlighting. */
  indices: number[];
}

const digitsOf = (text: string): string => text.replace(/\D/gu, '');

/** The chats that match `query` by name or number, best first (all of them, in order, for no query). */
export function searchForwardTargets(
  query: string,
  targets: readonly ForwardTarget[],
): TargetMatch[] {
  const text = query.trim();
  if (text === '') return targets.map((target) => ({ target, indices: [] }));
  const digits = digitsOf(text);
  const numeric = /^[\d\s+().-]+$/u.test(text) && digits.length >= 3;
  const scored: (TargetMatch & { score: number; order: number })[] = [];
  targets.forEach((target, order) => {
    const byName = fuzzyMatch(text, target.title);
    if (byName) scored.push({ target, indices: byName.indices, score: byName.score, order });
    else if (numeric && target.number && digitsOf(target.number).includes(digits))
      scored.push({ target, indices: [], score: 0, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map(({ target, indices }) => ({ target, indices }));
}

/** One attachment of a message being forwarded. */
export interface ForwardFileRef {
  /** Unique among the draft's files. */
  key: string;
  attachment: Attachment;
  fileName: string;
  contentType: string;
  voiceNote: boolean;
  size?: number;
  width?: number;
  height?: number;
}

/** A message as the dialog holds it: what will go out, and what the user may still change. */
export interface ForwardDraft {
  messageId: MessageId;
  /** The message's own attachment ids in order, for asking the phone to re-upload them all. */
  attachmentIds: readonly string[];
  authorId: string;
  sentAt: number;
  /** Position in the chat, for sending several in their original order. */
  order: number;
  sticker?: StickerContent;
  /** The body as markdown, mentions as plain `@name` text. */
  text: string;
  /** The same text without markup, for showing it (mentions as `@name`). */
  plain: string;
  files: ForwardFileRef[];
  preview?: LinkPreview;
  /** Whether the text and files can change (not a sticker or a voice message). */
  editable: boolean;
}

/** The link preview of `m`, when its link is still in the text. */
function carriedPreview(m: Message): LinkPreview | undefined {
  const preview = m.previews?.[0];
  return preview && m.body.includes(preview.url) ? preview : undefined;
}

export function draftOf(m: Message, nameFor: (id: string) => string): ForwardDraft {
  const draft: ForwardDraft = {
    messageId: m.id,
    attachmentIds: m.attachments.map((a) => a.id),
    authorId: m.authorId,
    sentAt: m.sentAt,
    order: m.seq ?? m.receivedAt,
    text: '',
    plain: '',
    files: [],
    editable: isForwardEditable(m),
  };
  if (m.sticker) {
    draft.sticker = m.sticker;
    return draft;
  }
  draft.plain = bodyToPlainText(m.body, m.ranges, nameFor).trim();
  draft.text = toMarkdown(m.body, m.ranges, (id) => escapeMarkdown(nameFor(id))).text;
  const voice = m.attachments.some(isVoiceNote);
  draft.files = m.attachments.map((attachment, i) => ({
    key: attachment.id,
    attachment,
    fileName: attachment.fileName ?? (voice ? 'voice-message' : `attachment-${i + 1}`),
    contentType: attachment.contentType,
    voiceNote: voice,
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.width !== undefined ? { width: attachment.width } : {}),
    ...(attachment.height !== undefined ? { height: attachment.height } : {}),
  }));
  const preview = carriedPreview(m);
  if (preview) draft.preview = preview;
  return draft;
}

/** Whether the draft still has something to send. */
export function draftHasContent(draft: ForwardDraft): boolean {
  return draft.sticker !== undefined || draft.text.trim() !== '' || draft.files.length > 0;
}

/** The link preview goes only while its link is still in the (possibly edited) text. */
export function previewStillApplies(draft: ForwardDraft): boolean {
  const url = draft.preview?.url;
  return url !== undefined && draft.text.replaceAll('\\', '').includes(url);
}
