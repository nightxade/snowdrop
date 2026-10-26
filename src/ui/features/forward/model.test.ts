import { describe, expect, it } from 'vitest';
import {
  directConversationId,
  MENTION_PLACEHOLDER,
  messageId,
  type Contact,
  type ConversationId,
  type ConversationView,
  type Message,
} from '@/core/domain';
import {
  buildForwardTargets,
  draftHasContent,
  draftOf,
  previewStillApplies,
  searchForwardTargets,
} from './model';

const contact = (id: string, patch: Partial<Contact> = {}): Contact => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  color: '#000',
  ...patch,
});

const view = (id: string, patch: Partial<ConversationView> = {}): ConversationView => ({
  id: id as ConversationId,
  kind: 'direct',
  title: id,
  memberIds: ['me', id.replace('dm:', '')],
  adminIds: [],
  expireTimerSec: 0,
  lastActivityAt: 1,
  pinned: false,
  muted: false,
  archived: false,
  ...patch,
});

const names = (id: string) => ({ mira: 'Mira Okafor', jon: 'Jon' })[id] ?? 'Someone';

const message = (patch: Partial<Message> = {}): Message => ({
  id: messageId('mira', 5),
  conversationId: 'dm:mira' as ConversationId,
  authorId: 'mira',
  sentAt: 5,
  receivedAt: 5,
  seq: 9,
  body: 'hello',
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'sent',
  kind: 'normal',
  ...patch,
});

describe('buildForwardTargets', () => {
  const mira = contact('mira', { number: '+12025550100' });
  const jon = contact('jon');
  const base = {
    contacts: { mira, jon, me: contact('me', { isSelf: true }) },
    composable: [mira, jon],
    self: contact('me', { isSelf: true }),
    requestState: () => 'accepted' as const,
  };

  it('lists conversations (unarchived first), then contacts with no chat yet', () => {
    const targets = buildForwardTargets({
      ...base,
      views: [
        view('dm:mira', { title: 'Mira', archived: true }),
        view('group:book', { kind: 'group', title: 'Book club', memberIds: ['me', 'mira', 'jon'] }),
      ],
    });
    expect(targets.map((t) => [t.id, t.meta])).toEqual([
      ['group:book', '3 members'],
      ['dm:mira', 'Direct message · Archived'],
      [directConversationId('me'), ''],
      [directConversationId('jon'), 'Contact'],
    ]);
    expect(targets.find((t) => t.id === 'dm:mira')?.number).toBe('+12025550100');
    expect(targets.at(-1)?.view).toBeUndefined();
  });

  it('keeps the chats the user cannot write to, with the reason', () => {
    const targets = buildForwardTargets({
      ...base,
      contacts: { ...base.contacts, jon: contact('jon', { blocked: true }) },
      views: [
        view('group:gone', { kind: 'group', title: 'Gone', memberIds: ['mira'], left: true }),
        view('group:news', {
          kind: 'group',
          title: 'News',
          memberIds: ['me', 'mira'],
          adminIds: ['mira'],
          permissions: {
            addMember: 'only-admins',
            editDetails: 'only-admins',
            sendMessages: 'only-admins',
          },
        }),
        view('group:open', { kind: 'group', title: 'Open', memberIds: ['me', 'mira'] }),
        view('dm:jon', { title: 'Jon' }),
      ],
    });
    const reason = (id: string) => targets.find((t) => t.id === id)?.unavailable;
    expect(reason('group:gone')).toBe('You left this group');
    expect(reason('group:news')).toBe('Only admins can send here');
    expect(reason('group:open')).toBeUndefined();
    expect(reason('dm:jon')).toBe('Blocked');
  });

  it('marks a message request, which forwarding accepts', () => {
    const targets = buildForwardTargets({
      ...base,
      views: [view('dm:mira', { title: 'Mira' })],
      requestState: () => 'request',
    });
    expect(targets.find((t) => t.id === 'dm:mira')?.request).toBe(true);
  });

  it('does not offer the user a second Note to Self when there is one', () => {
    const targets = buildForwardTargets({
      ...base,
      views: [view(directConversationId('me'), { title: 'Note to Self', memberIds: ['me'] })],
    });
    expect(targets.filter((t) => t.title === 'Note to Self')).toHaveLength(1);
  });
});

describe('searchForwardTargets', () => {
  const mk = (id: string, title: string, number?: string) =>
    buildForwardTargets({
      views: [view(id, { title })],
      contacts: number
        ? { [id.replace('dm:', '')]: contact(id.replace('dm:', ''), { number }) }
        : {},
      composable: [],
      self: contact('me', { isSelf: true }),
      requestState: () => 'accepted',
    })[0]!;

  it('keeps everything, in order, for no query', () => {
    const all = [mk('dm:a', 'Alpha'), mk('dm:b', 'Beta')];
    expect(searchForwardTargets('  ', all).map((m) => m.target.title)).toEqual(['Alpha', 'Beta']);
  });

  it('ranks by name and reports what matched, and finds a number', () => {
    const all = [mk('dm:a', 'Natalie'), mk('dm:b', 'Alice'), mk('dm:c', 'Zed', '+12025550123')];
    const byName = searchForwardTargets('ali', all);
    expect(byName.map((m) => m.target.title)).toEqual(['Alice', 'Natalie']);
    expect(byName[0]?.indices).toEqual([0, 1, 2]);
    expect(searchForwardTargets('202 555 0123', all).map((m) => m.target.title)).toEqual(['Zed']);
    expect(searchForwardTargets('nothing', all)).toEqual([]);
  });
});

describe('draftOf: what is carried', () => {
  it('carries the text with its styles; a mention becomes plain @name text', () => {
    const body = `hi ${MENTION_PLACEHOLDER} *this* is bold`;
    const bold = body.indexOf('bold');
    const draft = draftOf(
      message({
        body,
        ranges: [
          { start: 3, length: 1, mentionId: 'jon' },
          { start: bold, length: 4, style: 'bold' },
        ],
      }),
      names,
    );
    expect(draft.text).toBe('hi @Jon \\*this\\* is **bold**');
    expect(draft.plain).toBe('hi @Jon *this* is bold');
    expect(draft.editable).toBe(true);
  });

  it('escapes markup in a mentioned name so it cannot turn into formatting', () => {
    const draft = draftOf(
      message({ body: MENTION_PLACEHOLDER, ranges: [{ start: 0, length: 1, mentionId: 'x' }] }),
      () => 'A*B*',
    );
    expect(draft.text).toBe('@A\\*B\\*');
  });

  it('drops the quote, reactions and edit history; keeps nothing about the original sender in the content', () => {
    const draft = draftOf(
      message({
        quote: { authorId: 'jon', sentAt: 1, text: 'quoted words' },
        reactions: [{ emoji: '👍', authorId: 'jon', at: 1 }],
        edits: 2,
        editedAt: 9,
      }),
      names,
    );
    expect(JSON.stringify(draft)).not.toContain('quoted words');
    expect(draft.text).toBe('hello');
  });

  it('turns every attachment into a file, a voice message staying one (and then not editable)', () => {
    const draft = draftOf(
      message({
        body: '',
        attachments: [
          {
            id: 'a1',
            contentType: 'image/png',
            fileName: 'pic.png',
            size: 10,
            width: 4,
            height: 3,
          },
        ],
      }),
      names,
    );
    expect(draft.files).toMatchObject([
      {
        key: 'a1',
        fileName: 'pic.png',
        contentType: 'image/png',
        voiceNote: false,
        width: 4,
        height: 3,
      },
    ]);
    expect(draft.attachmentIds).toEqual(['a1']);
    const voice = draftOf(
      message({
        body: '',
        attachments: [{ id: 'v1', contentType: 'audio/aac', voiceNote: true }],
      }),
      names,
    );
    expect(voice.files[0]).toMatchObject({ voiceNote: true });
    expect(voice.editable).toBe(false);
    // An audio file with no name is a voice message too (older Android clients).
    const bare = draftOf(
      message({ body: '', attachments: [{ id: 'v2', contentType: 'audio/aac' }] }),
      names,
    );
    expect(bare.files[0]?.voiceNote).toBe(true);
  });

  it('sends a sticker on its own, not editable', () => {
    const draft = draftOf(
      message({ body: 'ignored', sticker: { packId: 'ab', stickerId: 2, emoji: '🙌' } }),
      names,
    );
    expect(draft.sticker).toEqual({ packId: 'ab', stickerId: 2, emoji: '🙌' });
    expect(draft.text).toBe('');
    expect(draft.files).toEqual([]);
    expect(draft.editable).toBe(false);
  });

  it('keeps a link preview only while its link is in the text', () => {
    const preview = { url: 'https://example.org/a_b', title: 'Example' };
    const kept = draftOf(
      message({ body: 'see https://example.org/a_b', previews: [preview] }),
      names,
    );
    expect(kept.preview).toEqual(preview);
    expect(previewStillApplies(kept)).toBe(true);
    // The markdown escapes the underscore, but it is the same link.
    expect(kept.text).toContain('\\_');
    expect(previewStillApplies({ ...kept, text: 'edited, no link' })).toBe(false);
    const dropped = draftOf(message({ body: 'no link', previews: [preview] }), names);
    expect(dropped.preview).toBeUndefined();
  });

  it('knows when nothing is left to send', () => {
    const draft = draftOf(message({ body: 'x' }), names);
    expect(draftHasContent(draft)).toBe(true);
    expect(draftHasContent({ ...draft, text: '  ' })).toBe(false);
    expect(
      draftHasContent({
        ...draft,
        text: '',
        files: [
          {
            key: 'a',
            attachment: { id: 'a', contentType: 'x/y' },
            fileName: 'a',
            contentType: 'x/y',
            voiceNote: false,
          },
        ],
      }),
    ).toBe(true);
  });
});
