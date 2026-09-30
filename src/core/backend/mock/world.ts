/**
 * Builds the deterministic demo world: contacts, conversations and several
 * days of history per conversation, from the scripts in ./content.
 *
 * Deterministic for a given (seed, now): the anchor day and time-of-day of
 * scripted messages are preserved, and everything lands before `now`.
 */
import {
  attachMentions,
  bodyToPlainText,
  colorForId,
  directConversationId,
  groupConversationId,
  messageId,
  parseMarkdownToRanges,
  MENTION_PLACEHOLDER,
  type Attachment,
  type Contact,
  type Conversation,
  type ConversationId,
  type Message,
  type Reaction,
} from '@/core/domain';
import {
  CASUAL_LINES,
  CONVERSATIONS,
  DEFAULT_SPACES,
  type ConversationSeed,
  type FileSeed,
  type ImageKind,
  type ScriptedMessage,
} from './content/conversations';
import { PEOPLE, SELF, type PersonSeed } from './content/people';
import { generateImageAttachment } from './images';
import { Random } from './prng';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const HISTORY_DAYS = 6;
const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '🙏', '💯', '😮', '✨'];

export interface MockWorld {
  self: Contact;
  /** Includes the local user (isSelf) so name lookups never miss. */
  contacts: Map<string, Contact>;
  conversations: Map<ConversationId, Conversation>;
  /** Ascending by sentAt. */
  histories: Map<ConversationId, Message[]>;
  readUpTo: Map<ConversationId, number>;
  personIds: Map<string, string>;
  conversationIds: Map<string, ConversationId>;
  lively: ConversationId[];
  pools: Map<ConversationId, readonly string[]>;
  defaultSpaces: {
    name: string;
    emoji: string;
    categories: { name: string; conversationIds: ConversationId[] }[];
  }[];
}

export interface WorldOptions {
  seed: number;
  now: number;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function makeContact(rnd: Random, seed: PersonSeed, index: number, isSelf: boolean): Contact {
  const id = rnd.uuid();
  const contact: Contact = {
    id,
    name: seed.name,
    color: colorForId(id),
  };
  // 555-01xx is reserved for fiction in the NANP.
  if (seed.sharesNumber) contact.number = `+1202555${String(100 + index).padStart(4, '0')}`;
  if (seed.profileName) contact.profileName = seed.profileName;
  if (seed.about) contact.about = seed.about;
  if (seed.aboutEmoji) contact.aboutEmoji = seed.aboutEmoji;
  if (isSelf) contact.isSelf = true;
  return contact;
}

/** Text with `{@}`/`{@me}` tokens → body + ranges. */
function renderText(
  rnd: Random,
  text: string,
  authorId: string,
  selfId: string,
  memberIds: readonly string[],
): { body: string; ranges: Message['ranges'] } {
  const mentionIds: string[] = [];
  const others = memberIds.filter((id) => id !== authorId && id !== selfId);
  const withPlaceholders = text.replace(/\{@(me)?\}/gu, (_m, me: string | undefined) => {
    const target = me && authorId !== selfId ? selfId : others.length ? rnd.pick(others) : selfId;
    mentionIds.push(target);
    return MENTION_PLACEHOLDER;
  });
  const parsed = parseMarkdownToRanges(withPlaceholders);
  return { body: parsed.body, ranges: attachMentions(parsed.body, parsed.ranges, mentionIds) };
}

function fileAttachment(seed: FileSeed, id: string): Attachment {
  const text = `Demo file "${seed.fileName}" from the Hearth mock world.\n`;
  return {
    id,
    contentType: seed.contentType,
    fileName: seed.fileName,
    size: seed.size,
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
  };
}

interface Draft {
  authorId: string;
  sentAt: number;
  text?: string;
  system?: string;
  images: ImageKind[];
  file?: FileSeed;
  replyTo?: Draft;
  reactions: Reaction[];
  edited: boolean;
  deleted: boolean;
  scripted: boolean;
}

class ConversationBuilder {
  private readonly drafts: Draft[] = [];
  private topicQueue: string[] = [];
  private casualQueue: string[] = [];

  constructor(
    private readonly rnd: Random,
    private readonly seed: ConversationSeed,
    private readonly selfId: string,
    private readonly memberIds: readonly string[],
    private readonly personId: (key: string) => string,
  ) {}

  private nextLine(queue: 'topic' | 'casual'): string {
    if (queue === 'topic') {
      if (this.topicQueue.length === 0) this.topicQueue = this.rnd.shuffle(this.seed.lines);
      return this.topicQueue.pop() ?? 'hello';
    }
    if (this.casualQueue.length === 0) this.casualQueue = this.rnd.shuffle(CASUAL_LINES);
    return this.casualQueue.pop() ?? 'ok';
  }

  private reactionsFor(authorId: string, sentAt: number, count: number): Reaction[] {
    const reactors = this.rnd.sample(
      this.memberIds.filter((id) => id !== authorId),
      count,
    );
    return reactors.map((id) => ({
      emoji: this.rnd.pick(REACTION_EMOJI),
      authorId: id,
      at: sentAt + this.rnd.int(1, 30) * MINUTE,
    }));
  }

  addScripted(list: readonly ScriptedMessage[], anchor: number): void {
    const placed: Draft[] = [];
    for (const s of list) {
      const sentAt =
        anchor -
        s.daysAgo * DAY +
        s.hour * 60 * MINUTE +
        s.minute * MINUTE +
        this.rnd.int(0, 59_000);
      const draft: Draft = {
        authorId: this.personId(s.author),
        sentAt,
        images: s.image === undefined ? [] : Array.isArray(s.image) ? s.image : [s.image],
        reactions: (s.reactions ?? []).map(([emoji, who], i) => ({
          emoji,
          authorId: this.personId(who),
          at: sentAt + (i + 1) * MINUTE,
        })),
        edited: s.edited ?? false,
        deleted: s.deleted ?? false,
        scripted: true,
      };
      if (s.text !== undefined) draft.text = s.text;
      if (s.system !== undefined) draft.system = s.system;
      if (s.file) draft.file = s.file;
      if (s.replyTo !== undefined) {
        const target = placed[placed.length - s.replyTo];
        if (target) draft.replyTo = target;
      }
      placed.push(draft);
      this.drafts.push(draft);
    }
  }

  addBursts(anchor: number, now: number): void {
    const isDm = this.seed.kind === 'direct';
    const others = this.memberIds.filter((id) => id !== this.selfId);
    const scriptedToday = (this.seed.scripted ?? []).some((m) => m.daysAgo === 0);
    // Day HISTORY_DAYS is reserved for scripted openings (group creation etc.).
    for (let day = HISTORY_DAYS - 1; day >= 0; day--) {
      // A conversation with a scripted "today" owns today, so its script stays newest.
      if (day === 0 && scriptedToday) continue;
      // Floor of ~every other day so quiet chats still have some history.
      const bursts = Math.max(
        this.rnd.chance(0.5) ? 1 : 0,
        Math.round(this.seed.activity * (0.4 + this.rnd.next() * 1.4)),
      );
      for (let b = 0; b < bursts; b++) {
        let t =
          anchor - day * DAY + this.rnd.int(8, 22) * 60 * MINUTE + this.rnd.int(0, 59) * MINUTE;
        const length = this.rnd.int(2, 9);
        let author = this.rnd.pick(others);
        for (let k = 0; k < length && t < now - 2 * MINUTE; k++) {
          if (k > 0 && !this.rnd.chance(0.35)) {
            author = this.rnd.chance(isDm ? 0.45 : 0.22) ? this.selfId : this.rnd.pick(others);
          }
          const draft: Draft = {
            authorId: author,
            sentAt: t,
            text: this.nextLine(this.rnd.chance(isDm ? 0.5 : 0.6) ? 'topic' : 'casual'),
            images: [],
            reactions: [],
            edited: this.rnd.chance(0.05),
            deleted: this.rnd.chance(0.02),
            scripted: false,
          };
          if (this.rnd.chance(0.22)) {
            draft.reactions = this.reactionsFor(
              author,
              t,
              this.rnd.int(1, Math.min(3, others.length)),
            );
          }
          if (this.rnd.chance(0.03))
            draft.images = [this.rnd.pick(['peaks', 'sunset', 'garden'] as const)];
          const recent = this.drafts.slice(-5).filter((d) => !d.system && !d.deleted);
          if (recent.length > 0 && this.rnd.chance(0.1)) draft.replyTo = this.rnd.pick(recent);
          this.drafts.push(draft);
          t += this.rnd.chance(0.1) ? this.rnd.int(8, 20) * MINUTE : this.rnd.int(15, 240) * 1000;
        }
      }
    }
  }

  /** Makes sure the newest `n` messages are from other people, so unread counts show. */
  reserveUnread(n: number): void {
    const others = this.memberIds.filter((id) => id !== this.selfId);
    const sorted = [...this.drafts].sort((a, b) => a.sentAt - b.sentAt);
    let seen = 0;
    for (let i = sorted.length - 1; i >= 0 && seen < n; i--) {
      const d = sorted[i] as Draft;
      if (d.system) continue;
      if (d.authorId === this.selfId) {
        if (d.scripted) break;
        d.authorId = this.rnd.pick(others);
      }
      d.deleted = false;
      seen++;
    }
  }

  build(
    conversationId: ConversationId,
    nameFor: (id: string) => string,
  ): { messages: Message[]; readUpTo: number } {
    const drafts = [...this.drafts].sort((a, b) => a.sentAt - b.sentAt);
    const used = new Set<string>();
    const byDraft = new Map<Draft, Message>();
    const messages: Message[] = [];

    for (const d of drafts) {
      while (used.has(`${d.authorId}:${d.sentAt}`)) d.sentAt++;
      used.add(`${d.authorId}:${d.sentAt}`);

      const rendered = d.text
        ? renderText(this.rnd, d.text, d.authorId, this.selfId, this.memberIds)
        : { body: '', ranges: [] };
      const attachments: Attachment[] = d.images.map((kind, i) =>
        generateImageAttachment(this.rnd, kind, `${d.sentAt.toString(36)}-${i}`),
      );
      if (d.file) attachments.push(fileAttachment(d.file, `${d.sentAt.toString(36)}-f`));

      const isSelf = d.authorId === this.selfId;
      let message: Message = {
        id: messageId(d.authorId, d.sentAt),
        conversationId,
        authorId: d.authorId,
        sentAt: d.sentAt,
        receivedAt: d.sentAt + (isSelf ? 0 : this.rnd.int(200, 4000)),
        body: rendered.body,
        ranges: rendered.ranges,
        attachments,
        reactions: d.reactions,
        status: 'read',
        kind: d.system ? 'system' : 'normal',
      };
      if (d.system) message.systemText = d.system;
      const quoted = d.replyTo ? byDraft.get(d.replyTo) : undefined;
      if (quoted) {
        message.quote = {
          authorId: quoted.authorId,
          sentAt: quoted.sentAt,
          text: bodyToPlainText(quoted.body, quoted.ranges, nameFor),
        };
      }
      if (d.edited && !d.system) {
        message.edits = 1;
        message.editedAt = d.sentAt + this.rnd.int(1, 10) * MINUTE;
      }
      if (d.deleted && !d.system) {
        const { quote: _q, ...rest } = message;
        message = { ...rest, deleted: true, body: '', ranges: [], attachments: [], reactions: [] };
      }
      byDraft.set(d, message);
      messages.push(message);
    }

    // The newest own message is merely delivered, which makes the status UI visible.
    const lastOwn = messages.findLast((m) => m.authorId === this.selfId && m.kind === 'normal');
    if (lastOwn) lastOwn.status = 'delivered';

    const unread = this.seed.unread ?? 0;
    let readUpTo = messages.at(-1)?.sentAt ?? 0;
    if (unread > 0) {
      const fromOthers = messages.filter((m) => m.authorId !== this.selfId && m.kind === 'normal');
      const firstUnread = fromOthers[Math.max(0, fromOthers.length - unread)];
      if (firstUnread) readUpTo = firstUnread.sentAt - 1;
    }
    return { messages, readUpTo };
  }
}

export function buildWorld({ seed, now }: WorldOptions): MockWorld {
  // Identities come from their own stream so they're stable across launches
  // (persisted spaces reference them) even though content depends on `now`.
  const idRnd = new Random(seed);
  const rnd = new Random(seed ^ 0x9e3779b9);

  const self = makeContact(idRnd, SELF, 0, true);
  const contacts = new Map<string, Contact>([[self.id, self]]);
  const personIds = new Map<string, string>([[SELF.key, self.id]]);
  PEOPLE.forEach((p, i) => {
    const c = makeContact(idRnd, p, i + 1, false);
    contacts.set(c.id, c);
    personIds.set(p.key, c.id);
  });
  const personId = (key: string): string => {
    const id = personIds.get(key);
    if (!id) throw new Error(`mock world: unknown person "${key}"`);
    return id;
  };
  const nameFor = (id: string): string => contacts.get(id)?.name ?? 'Unknown';

  // Keep scripted times-of-day truthful: if "today" hasn't reached the latest
  // scripted moment yet, anchor the whole script one day earlier.
  const latestToday = Math.max(
    0,
    ...CONVERSATIONS.flatMap((c) => c.scripted ?? [])
      .filter((s) => s.daysAgo === 0)
      .map((s) => (s.hour * 60 + s.minute + 2) * MINUTE),
  );
  let anchor = startOfDay(now);
  if (now - anchor < latestToday) anchor = startOfDay(anchor - DAY / 2);

  const conversations = new Map<ConversationId, Conversation>();
  const histories = new Map<ConversationId, Message[]>();
  const readUpTo = new Map<ConversationId, number>();
  const conversationIds = new Map<string, ConversationId>();
  const lively: ConversationId[] = [];
  const pools = new Map<ConversationId, readonly string[]>();

  for (const seedConv of CONVERSATIONS) {
    const memberIds = [self.id, ...seedConv.members.map(personId)];
    const peer = seedConv.kind === 'direct' ? personId(seedConv.members[0] ?? '') : undefined;
    const groupKey = idRnd.base64(32); // drawn for DMs too, keeping the stream aligned
    const id = peer ? directConversationId(peer) : groupConversationId(groupKey);
    conversationIds.set(seedConv.key, id);

    const builder = new ConversationBuilder(rnd, seedConv, self.id, memberIds, personId);
    builder.addBursts(anchor, now);
    builder.addScripted(seedConv.scripted ?? [], anchor);
    builder.reserveUnread(seedConv.unread ?? 0);
    const { messages, readUpTo: cursor } = builder.build(id, nameFor);

    const conversation: Conversation = {
      id,
      kind: seedConv.kind,
      title: peer ? nameFor(peer) : (seedConv.title ?? 'Group'),
      memberIds,
      adminIds: (seedConv.admins ?? []).map(personId),
      muted: seedConv.muted ?? false,
      archived: false,
      pinned: seedConv.pinned ?? false,
      expireTimerSec: seedConv.expireTimerSec ?? 0,
      lastActivityAt: messages.at(-1)?.sentAt ?? now - HISTORY_DAYS * DAY,
    };
    if (seedConv.description) conversation.description = seedConv.description;

    conversations.set(id, conversation);
    histories.set(id, messages);
    readUpTo.set(id, cursor);
    pools.set(id, [...seedConv.lines, ...CASUAL_LINES]);
    if (seedConv.lively) lively.push(id);
  }

  const defaultSpaces = DEFAULT_SPACES.map((s) => ({
    name: s.name,
    emoji: s.emoji,
    categories: s.categories.map((c) => ({
      name: c.name,
      conversationIds: c.conversations.map((key) => {
        const cid = conversationIds.get(key);
        if (!cid) throw new Error(`mock world: unknown conversation "${key}"`);
        return cid;
      }),
    })),
  }));

  return {
    self,
    contacts,
    conversations,
    histories,
    readUpTo,
    personIds,
    conversationIds,
    lively,
    pools,
    defaultSpaces,
  };
}

export { renderText as renderMockText };
