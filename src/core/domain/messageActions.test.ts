import { describe, expect, it } from 'vitest';
import { directConversationId, groupConversationId, pendingMessageId } from './ids';
import { messagePermissions, type MessageActionFacts } from './messageActions';
import { makeConversation, makeMessage } from './testing';
import { DAY } from './time';

const NOW = 100 * DAY;
const group = makeConversation({
  id: groupConversationId('g'),
  memberIds: ['me', 'ana'],
  adminIds: ['ana'],
});
const facts = (partial: Partial<MessageActionFacts> = {}): MessageActionFacts => ({
  selfId: 'me',
  conversation: group,
  accepted: true,
  capabilities: { pin: true, adminDelete: true, polls: true },
  now: NOW,
  ...partial,
});
const theirs = (partial = {}) =>
  makeMessage({ authorId: 'ana', body: 'hi', sentAt: NOW - 1000, ...partial });
const mine = (partial = {}) =>
  makeMessage({ authorId: 'me', body: 'hi', sentAt: NOW - 1000, ...partial });

describe('messagePermissions', () => {
  it('offers an ordinary received message its usual actions', () => {
    expect(messagePermissions(theirs(), facts())).toMatchObject({
      canReply: true,
      canReact: true,
      canForward: true,
      canCopy: true,
      canDelete: true,
      canDeleteForEveryone: false,
      canEdit: false,
      canPin: true,
      canShowDetails: false,
    });
  });

  it('offers our own message edit, delete for everyone and details', () => {
    expect(messagePermissions(mine(), facts())).toMatchObject({
      canEdit: true,
      canDeleteForEveryone: true,
      canShowDetails: true,
    });
  });

  it('offers reply only where there is a composer to answer in', () => {
    const request = messagePermissions(theirs(), facts({ accepted: false }));
    expect(request).toMatchObject({ canCompose: false, canReply: false, canReact: false });
    const announcement = makeConversation({
      ...group,
      permissions: {
        sendMessages: 'only-admins',
        addMember: 'every-member',
        editDetails: 'every-member',
      },
    });
    const readOnly = messagePermissions(theirs(), facts({ conversation: announcement }));
    expect(readOnly).toMatchObject({ canCompose: false, canReply: false });
    // An admin can write in an announcement group; so can everyone in an open one.
    expect(
      messagePermissions(theirs(), facts({ conversation: announcement, selfId: 'ana' })).canReply,
    ).toBe(true);
    const left = makeConversation({ ...group, left: true });
    expect(messagePermissions(theirs(), facts({ conversation: left })).canReply).toBe(false);
    expect(
      messagePermissions(
        theirs(),
        facts({
          conversation: makeConversation({ id: directConversationId('ana'), kind: 'direct' }),
        }),
      ).canReply,
    ).toBe(true);
  });

  it('offers nothing but retry and discard for a failed message', () => {
    expect(messagePermissions(mine({ status: 'failed' }), facts())).toMatchObject({
      failed: true,
      canReply: false,
      canEdit: false,
      canReact: false,
      canPin: false,
      canDelete: false,
      canShowDetails: false,
    });
  });

  it('copies only text, and never a deleted message', () => {
    expect(messagePermissions(theirs({ body: '' }), facts()).canCopy).toBe(false);
    expect(messagePermissions(theirs({ deleted: true }), facts()).canCopy).toBe(false);
  });

  it('keeps a message that is still sending out of edit (it has no identity yet)', () => {
    const pending = mine({ id: pendingMessageId('n'), status: 'pending' });
    expect(messagePermissions(pending, facts())).toMatchObject({ pending: true, canEdit: false });
  });

  it('closes edit with the window and the edit limit', () => {
    expect(messagePermissions(mine({ sentAt: NOW - 2 * DAY }), facts()).canEdit).toBe(false);
    expect(messagePermissions(mine({ edits: 10 }), facts()).canEdit).toBe(false);
  });

  it('gates admin delete and pin on the transport and the role', () => {
    expect(messagePermissions(theirs(), facts({ selfId: 'ana' })).canAdminDelete).toBe(false);
    const asAdminOfOthers = makeConversation({ ...group, adminIds: ['me'] });
    expect(
      messagePermissions(theirs(), facts({ conversation: asAdminOfOthers })).canAdminDelete,
    ).toBe(true);
    expect(
      messagePermissions(
        theirs(),
        facts({
          conversation: asAdminOfOthers,
          capabilities: { pin: false, adminDelete: false, polls: true },
        }),
      ),
    ).toMatchObject({ canAdminDelete: false, canPin: false });
  });

  it('closes delete for everyone (and admin delete) 24 hours after sending, and in note-to-self', () => {
    const old = { sentAt: NOW - 2 * DAY };
    expect(messagePermissions(mine(old), facts())).toMatchObject({
      canDeleteForEveryone: false,
      canDelete: true,
    });
    const asAdmin = makeConversation({ ...group, adminIds: ['me'] });
    expect(messagePermissions(theirs(old), facts({ conversation: asAdmin })).canAdminDelete).toBe(
      false,
    );
    const own = makeConversation({ id: directConversationId('me'), kind: 'direct' });
    expect(
      messagePermissions(mine({ conversationId: own.id }), facts({ conversation: own }))
        .canDeleteForEveryone,
    ).toBe(false);
  });

  it('offers no sending action where the chat cannot send: left, blocked or announcement-only', () => {
    const announcement = makeConversation({
      ...group,
      adminIds: ['ana'],
      permissions: {
        sendMessages: 'only-admins',
        addMember: 'every-member',
        editDetails: 'every-member',
      },
    });
    const left = makeConversation({ ...group, left: true });
    const asAdmin = makeConversation({ ...group, adminIds: ['me'], left: true });
    const sending = {
      canReact: false,
      canEdit: false,
      canPin: false,
      canDeleteForEveryone: false,
      canReply: false,
    };
    const states: Partial<MessageActionFacts>[] = [
      { conversation: left },
      { conversation: announcement },
      { accepted: false }, // blocked chats are not accepted either
    ];
    for (const state of states) {
      expect(messagePermissions(mine(), facts(state))).toMatchObject({
        ...sending,
        canCopy: true,
        canDelete: true,
        canForward: state.accepted !== false,
        canShowDetails: true,
      });
      expect(messagePermissions(theirs(), facts(state))).toMatchObject({
        canReact: false,
        canPin: false,
        canReply: false,
        canCopy: true,
        canDelete: true,
      });
    }
    // Delete for everyone by an admin is a sending action too.
    expect(messagePermissions(theirs(), facts({ conversation: asAdmin })).canAdminDelete).toBe(
      false,
    );
  });
});
