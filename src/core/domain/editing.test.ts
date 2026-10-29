import { describe, expect, it } from 'vitest';
import {
  EDIT_WINDOW_MS,
  INCOMING_EDIT_WINDOW_MS,
  MAX_EDITS,
  DELETE_WINDOW_MS,
  canEditMessage,
  editRefusal,
  isEditableContent,
  isNoteToSelf,
  isTooOldToEdit,
  isWithinDeleteWindow,
} from './editing';
import { directConversationId, pendingMessageId } from './ids';
import { makeMessage } from './testing';
import { DAY } from './time';

const NOW = 100 * DAY;
const facts = { selfId: 'me', now: NOW };
const mine = (partial = {}) =>
  makeMessage({ authorId: 'me', body: 'hello', sentAt: NOW - 1000, ...partial });

describe('canEditMessage', () => {
  it('allows our own text within the window', () => {
    expect(canEditMessage(mine(), facts)).toBe(true);
  });

  it('refuses what is not ours, deleted, or not an ordinary message', () => {
    expect(canEditMessage(mine({ authorId: 'ana' }), facts)).toBe(false);
    expect(canEditMessage(mine({ deleted: true }), facts)).toBe(false);
    expect(canEditMessage(mine({ kind: 'system' }), facts)).toBe(false);
    expect(canEditMessage(mine(), { selfId: null, now: NOW })).toBe(false);
  });

  it('refuses a message with nothing to edit: no text, a sticker, a poll, a voice note', () => {
    expect(canEditMessage(mine({ body: '' }), facts)).toBe(false);
    expect(canEditMessage(mine({ sticker: { packId: 'p', stickerId: 1 } }), facts)).toBe(false);
    const poll = { question: 'q', options: ['a', 'b'], allowMultiple: false, votes: [] };
    expect(canEditMessage(mine({ poll }), facts)).toBe(false);
    const voice = [{ id: 'a', contentType: 'audio/mpeg', voiceNote: true }];
    expect(canEditMessage(mine({ attachments: voice }), facts)).toBe(false);
    // A caption on a photo can be edited.
    const photo = [{ id: 'a', contentType: 'image/png', fileName: 'x.png' }];
    expect(canEditMessage(mine({ attachments: photo }), facts)).toBe(true);
  });

  it('closes 24 hours after sending', () => {
    expect(canEditMessage(mine({ sentAt: NOW - EDIT_WINDOW_MS + 1 }), facts)).toBe(true);
    expect(canEditMessage(mine({ sentAt: NOW - EDIT_WINDOW_MS }), facts)).toBe(false);
    expect(canEditMessage(mine({ sentAt: NOW - 3 * DAY }), facts)).toBe(false);
  });

  it('allows ten edits and no more', () => {
    expect(canEditMessage(mine({ edits: MAX_EDITS - 1 }), facts)).toBe(true);
    expect(canEditMessage(mine({ edits: MAX_EDITS }), facts)).toBe(false);
  });

  it('exempts note-to-self from both limits', () => {
    const own = directConversationId('me');
    const old = mine({ conversationId: own, sentAt: NOW - 30 * DAY, edits: 40 });
    expect(canEditMessage(old, facts)).toBe(true);
    expect(isNoteToSelf(own, 'me')).toBe(true);
    expect(isNoteToSelf(directConversationId('ana'), 'me')).toBe(false);
  });

  it('is not offered for a message that has not gone out or failed', () => {
    const pending = mine({ id: pendingMessageId('n'), status: 'pending' });
    expect(canEditMessage(pending, facts)).toBe(false);
    expect(canEditMessage(mine({ status: 'failed' }), facts)).toBe(false);
    // The content rule alone (what the service enforces) still holds for them.
    expect(isEditableContent(pending, facts)).toBe(true);
  });
});

describe('isTooOldToEdit', () => {
  const target = { conversationId: directConversationId('ana'), sentAt: NOW - 3 * DAY };

  it('drops an edit that reaches the server more than 48 hours after the message', () => {
    expect(isTooOldToEdit(target, NOW, 'me')).toBe(true);
    expect(isTooOldToEdit({ ...target, sentAt: NOW - INCOMING_EDIT_WINDOW_MS }, NOW, 'me')).toBe(
      false,
    );
    expect(isTooOldToEdit({ ...target, sentAt: NOW - DAY }, NOW, 'me')).toBe(false);
  });

  it('exempts note-to-self', () => {
    expect(
      isTooOldToEdit({ ...target, conversationId: directConversationId('me') }, NOW, 'me'),
    ).toBe(false);
  });
});

describe('editRefusal', () => {
  it('says why in words, and nothing when the edit is fine', () => {
    expect(editRefusal(mine(), facts)).toBeUndefined();
    expect(editRefusal(mine({ sentAt: NOW - 2 * DAY }), facts)).toBe(
      'Messages can only be edited for 24 hours.',
    );
    expect(editRefusal(mine({ edits: 10 }), facts)).toBe('A message can only be edited 10 times.');
    expect(editRefusal(mine({ body: '' }), facts)).toBe("This message can't be edited.");
  });
});

describe('isWithinDeleteWindow', () => {
  const m = { conversationId: directConversationId('ana'), sentAt: NOW - 1000 };

  it('lasts 24 hours from sending, like Desktop', () => {
    expect(isWithinDeleteWindow(m, NOW, 'me')).toBe(true);
    expect(isWithinDeleteWindow({ ...m, sentAt: NOW - DELETE_WINDOW_MS }, NOW, 'me')).toBe(true);
    expect(isWithinDeleteWindow({ ...m, sentAt: NOW - DELETE_WINDOW_MS - 1 }, NOW, 'me')).toBe(
      false,
    );
  });

  it('is never open in note-to-self (Desktop only deletes it here)', () => {
    expect(
      isWithinDeleteWindow({ ...m, conversationId: directConversationId('me') }, NOW, 'me'),
    ).toBe(false);
  });
});
