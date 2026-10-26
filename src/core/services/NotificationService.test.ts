import { describe, expect, it, vi } from 'vitest';
import {
  directConversationId,
  MENTION_PLACEHOLDER,
  type Message,
  type PollContent,
} from '@/core/domain';
import { conversationIdFor, makeConversation, makeMessage } from '@/core/domain/testing';
import { Emitter } from '@/core/lib';
import { createStores, HOME } from '@/core/stores';
import {
  NotificationService,
  notificationText,
  type NotificationApi,
  type NotificationPermissionState,
  type PollActivityEvent,
} from './NotificationService';

const NOW = 1_000_000;
const group = conversationIdFor('g');
const dm = directConversationId('ana');
const requestDm = directConversationId('eve');
const requestGroup = conversationIdFor('spam-group');

function setup(options: { permission?: NotificationPermissionState; visible?: boolean } = {}) {
  const stores = createStores();
  stores.session.getState().setSelf({ id: 'me', name: 'Me', color: 'x', isSelf: true });
  stores.contacts.getState().upsertMany([
    { id: 'ana', name: 'Ana Lima', color: 'x', inContacts: true },
    { id: 'bo', name: 'Bo Chen', color: 'x', inContacts: true },
    { id: 'eve', name: 'Eve Stranger', color: 'x' },
  ]);
  stores.conversations.getState().upsertMany([
    makeConversation({
      id: group,
      kind: 'group',
      title: 'Climbing',
      memberIds: ['me', 'ana', 'bo'],
    }),
    makeConversation({ id: dm, kind: 'direct', title: 'Ana Lima', memberIds: ['me', 'ana'] }),
    makeConversation({ id: requestDm, kind: 'direct', title: 'Eve', memberIds: ['me', 'eve'] }),
    makeConversation({
      id: requestGroup,
      kind: 'group',
      title: 'Free crypto',
      memberIds: ['me', 'eve'],
    }),
  ]);
  const shown: { title: string; body: string; tag: string; click: () => void }[] = [];
  const closed = vi.fn();
  let permission = options.permission ?? 'granted';
  const api: NotificationApi = {
    permission: () => permission,
    request: () => {
      permission = 'granted';
      return Promise.resolve(permission);
    },
    show: (content, onClick) => {
      shown.push({ ...content, click: onClick });
      return { close: closed };
    },
  };
  const source = new Emitter<{
    messageArrived: { message: Message; live: boolean };
    pollActivity: PollActivityEvent;
  }>();
  const focusWindow = vi.fn();
  const boost = vi.fn<(m: Message) => string | null>(() => null);
  const service = new NotificationService({
    stores,
    api,
    clock: { now: () => NOW },
    source,
    boost,
    isVisible: () => options.visible ?? true,
    focusWindow,
  });
  service.start();
  const receive = (partial: Partial<Message>, live = true) => {
    source.emit('messageArrived', {
      live,
      message: makeMessage({
        conversationId: group,
        authorId: 'ana',
        sentAt: NOW,
        body: 'hello',
        ...partial,
      }),
    });
  };
  const pollActivity = (
    kind: PollActivityEvent['kind'],
    actorId: string,
    partial: Partial<Message> = {},
    live = true,
  ) => {
    source.emit('pollActivity', {
      kind,
      actorId,
      live,
      message: makeMessage({
        conversationId: group,
        authorId: 'me',
        sentAt: NOW,
        poll: {
          question: 'Where to eat?',
          options: ['Pizza', 'Ramen'],
          allowMultiple: true,
          votes: [],
        } satisfies PollContent,
        ...partial,
      }),
    });
  };
  return { stores, service, shown, closed, receive, pollActivity, focusWindow, boost };
}

const mention = (id: string) => ({
  body: `${MENTION_PLACEHOLDER} look`,
  ranges: [{ start: 0, length: 1, mentionId: id }],
});

describe('NotificationService', () => {
  it('notifies for a new message with group title and author prefix', () => {
    const { shown, receive } = setup();
    receive({});
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: 'Climbing',
      body: 'Ana Lima: hello',
      tag: `snowdrop:${group}`,
    });
  });

  it('silences initial sync and old envelopes delivered after sync finishes', () => {
    const { shown, receive } = setup();
    receive({ sentAt: NOW }, false);
    receive({ sentAt: NOW - 1 });
    expect(shown).toHaveLength(0);
    receive({ sentAt: NOW + 1 });
    expect(shown).toHaveLength(1);
  });

  it('silences messages processed while notifications are held for a catch-up', () => {
    const { stores, shown, receive } = setup();
    stores.session.getState().setNotificationsHeld(true);
    // Live (not parked by SyncService's own gate) and new enough to otherwise notify.
    receive({ sentAt: NOW + 1 });
    expect(shown).toHaveLength(0);
    stores.session.getState().setNotificationsHeld(false);
    receive({ sentAt: NOW + 2 });
    expect(shown).toHaveLength(1);
  });

  it('the sidebar catch-up flag alone does not hold notifications (its ceiling is shorter)', () => {
    const { stores, shown, receive } = setup();
    stores.session.getState().setNotificationsHeld(true);
    stores.session.getState().setCatchingUp(false);
    receive({ sentAt: NOW + 1 });
    expect(shown).toHaveLength(0);
    stores.session.getState().setNotificationsHeld(false);
    stores.session.getState().setCatchingUp(true);
    receive({ sentAt: NOW + 2 });
    expect(shown).toHaveLength(1);
  });

  it('never notifies for own, system or deleted messages, or without permission', () => {
    const a = setup();
    a.receive({ authorId: 'me' });
    a.receive({ kind: 'system' });
    a.receive({ deleted: true });
    expect(a.shown).toHaveLength(0);
    const b = setup({ permission: 'default' });
    b.receive({});
    expect(b.shown).toHaveLength(0);
  });

  it('respects the master switch and the "nothing" mode', () => {
    const { stores, shown, receive } = setup();
    stores.settings.getState().update('notifications', { enabled: false });
    receive({});
    stores.settings.getState().update('notifications', { enabled: true, mode: 'none' });
    receive(mention('me'));
    expect(shown).toHaveLength(0);
  });

  it('stays quiet for the conversation you are looking at (focused + visible + at the bottom)', () => {
    const { stores, shown, receive } = setup();
    stores.ui.getState().selectConversation(group, HOME);
    receive({});
    expect(shown).toHaveLength(0);
    // Scrolled up: you can't see it arrive.
    stores.ui.getState().setScrolledUp(group, true);
    receive({ sentAt: NOW + 1 });
    stores.ui.getState().setScrolledUp(group, false);
    stores.ui.getState().setWindowFocused(false);
    receive({ sentAt: NOW + 2 });
    expect(shown).toHaveLength(2);
  });

  it('notifies for the open conversation when the tab is hidden', () => {
    const { stores, shown, receive } = setup({ visible: false });
    stores.ui.getState().selectConversation(group, HOME);
    receive({});
    expect(shown).toHaveLength(1);
  });

  it('muted conversations (with expiry) and spaces only let mentions and boosts through', () => {
    const { stores, shown, receive, boost } = setup();
    stores.local.getState().setMuted(group, { until: NOW + 60_000 });
    receive({});
    expect(shown).toHaveLength(0);
    receive({ ...mention('me'), sentAt: NOW + 1 });
    expect(shown).toHaveLength(1);
    boost.mockReturnValueOnce('Keyword “deploy”');
    receive({ body: 'deploy now', sentAt: NOW + 2 });
    expect(shown[1]?.body).toBe('Keyword “deploy” · Ana Lima: deploy now');
    // Expired mute: back to normal.
    stores.local.getState().setMuted(group, { until: NOW - 1 });
    receive({ sentAt: NOW + 3 });
    expect(shown).toHaveLength(3);
    // Space mute.
    const space = stores.spaces.getState().createSpace({ name: 'S', conversationIds: [group] });
    stores.spaces.getState().updateSpace(space, { muted: true });
    receive({ sentAt: NOW + 4 });
    expect(shown).toHaveLength(3);
  });

  it('mentions-only mode: groups need a mention or boost; DMs still notify', () => {
    const { stores, shown, receive } = setup();
    stores.settings.getState().update('notifications', { mode: 'mentions' });
    receive({});
    expect(shown).toHaveLength(0);
    receive({ conversationId: dm, sentAt: NOW + 1 });
    expect(shown[0]?.title).toBe('Ana Lima');
    receive({ ...mention('me'), sentAt: NOW + 2 });
    expect(shown[1]?.body).toBe('Ana Lima: @Me look');
  });

  it('hides text when previews are off and never reveals spoilers', () => {
    const { stores, shown, receive } = setup();
    receive({ body: 'the end: he dies', ranges: [{ start: 9, length: 7, style: 'spoiler' }] });
    expect(shown[0]?.body).toBe('Ana Lima: the end: ▒▒▒▒');
    stores.settings.getState().update('notifications', { showPreview: false });
    receive({ sentAt: NOW + 1 });
    expect(shown[1]?.body).toBe('New message');
  });

  it('replaces the previous notification of a conversation', () => {
    const { shown, closed, receive } = setup();
    receive({});
    receive({ sentAt: NOW + 1 });
    expect(shown).toHaveLength(2);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('clicking focuses the window and opens the conversation in its space', () => {
    const { stores, shown, receive, focusWindow } = setup();
    const space = stores.spaces.getState().createSpace({ name: 'S', conversationIds: [group] });
    stores.ui.getState().openModal({ type: 'settings' });
    receive({});
    shown[0]!.click();
    expect(focusWindow).toHaveBeenCalled();
    const ui = stores.ui.getState();
    expect(ui.selectedSpace).toBe(space);
    expect(ui.selectedConversationBySpace[space]).toBe(group);
    expect(ui.modal).toBeNull();
  });

  it('summarises attachment-only messages', () => {
    expect(
      notificationText(
        { body: '', ranges: [], attachments: [{ id: 'a', contentType: 'image/png' }] },
        () => '',
      ),
    ).toBe('Sent an attachment');
  });

  it('summarises a sticker, with its emoji when known', () => {
    expect(
      notificationText(
        { body: '', ranges: [], attachments: [], sticker: { packId: 'ab', stickerId: 1 } },
        () => '',
      ),
    ).toBe('Sticker');
    expect(
      notificationText(
        {
          body: '',
          ranges: [],
          attachments: [],
          sticker: { packId: 'ab', stickerId: 1, emoji: '🎉' },
        },
        () => '',
      ),
    ).toBe('🎉 Sticker');
  });

  describe('message requests (as Signal Desktop shows them)', () => {
    it('shows the sender and "Message Request", never the text, for an unaccepted direct chat', () => {
      const { shown, receive } = setup();
      receive({ conversationId: requestDm, authorId: 'eve', body: 'send me your seed phrase' });
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ title: 'Eve Stranger', body: 'Message Request' });
    });

    it('names the sender and the group in the title for an unaccepted group', () => {
      const { shown, receive } = setup();
      receive({ conversationId: requestGroup, authorId: 'eve', body: 'click this link' });
      expect(shown[0]).toMatchObject({
        title: 'Eve Stranger in Free crypto',
        body: 'Message Request',
      });
    });

    it('hides even the sender-independent text when previews are off', () => {
      const { stores, shown, receive } = setup();
      stores.settings.getState().update('notifications', { showPreview: false });
      receive({ conversationId: requestDm, authorId: 'eve', body: 'secret words' });
      expect(shown[0]?.body).toBe('New message');
    });

    it('shows the real text once the request is accepted', () => {
      const { stores, shown, receive } = setup();
      stores.local.getState().markAccepted(requestDm, NOW);
      receive({ conversationId: requestDm, authorId: 'eve', body: 'hello again' });
      expect(shown[0]).toMatchObject({ title: 'Eve Stranger', body: 'hello again' });
    });
  });

  describe('polls (as Signal Desktop words them)', () => {
    it('names the voter and the question when someone votes on a poll of yours', () => {
      const { shown, pollActivity } = setup();
      pollActivity('vote', 'ana');
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({
        title: 'Climbing',
        body: 'Ana Lima voted in the poll "Where to eat?"',
        tag: `snowdrop:${group}`,
      });
    });

    it('says who ended a poll, with the poll marker', () => {
      const { shown, pollActivity } = setup();
      pollActivity('end', 'bo', { authorId: 'bo' });
      expect(shown[0]?.body).toBe('📊 Bo Chen ended the poll: Where to eat?');
    });

    it('titles a direct chat with the person', () => {
      const { shown, pollActivity } = setup();
      pollActivity('vote', 'ana', { conversationId: dm });
      expect(shown[0]?.title).toBe('Ana Lima');
    });

    it('follows the same rules as a message: viewing, mute, mentions-only, switches', () => {
      const { stores, shown, pollActivity } = setup();
      stores.ui.getState().selectConversation(group, HOME);
      pollActivity('vote', 'ana');
      expect(shown).toHaveLength(0);
      stores.ui.getState().setWindowFocused(false);
      stores.local.getState().setMuted(group, true);
      pollActivity('vote', 'ana');
      expect(shown).toHaveLength(0);
      stores.local.getState().setMuted(group, false);
      stores.settings.getState().update('notifications', { mode: 'mentions' });
      pollActivity('vote', 'ana');
      expect(shown).toHaveLength(0);
      stores.settings.getState().update('notifications', { mode: 'all', enabled: false });
      pollActivity('vote', 'ana');
      expect(shown).toHaveLength(0);
      stores.settings.getState().update('notifications', { enabled: true });
      pollActivity('vote', 'ana');
      expect(shown).toHaveLength(1);
    });

    it('never reveals the question when previews are off, nor to an unaccepted request', () => {
      const { stores, shown, pollActivity } = setup();
      stores.settings.getState().update('notifications', { showPreview: false });
      pollActivity('vote', 'ana');
      expect(shown[0]?.body).toBe('New message');
      stores.settings.getState().update('notifications', { showPreview: true });
      pollActivity('vote', 'eve', { conversationId: requestDm });
      expect(shown[1]).toMatchObject({ title: 'Eve Stranger', body: 'Message Request' });
    });

    it('stays silent for old news, our own actions, deleted polls and missing permission', () => {
      const { stores, shown, pollActivity } = setup();
      pollActivity('vote', 'ana', {}, false);
      pollActivity('vote', 'me');
      pollActivity('vote', 'ana', { deleted: true });
      stores.session.getState().setNotificationsHeld(true);
      pollActivity('vote', 'ana');
      expect(shown).toHaveLength(0);
      const denied = setup({ permission: 'default' });
      denied.pollActivity('vote', 'ana');
      expect(denied.shown).toHaveLength(0);
    });

    it('summarises a poll message by its question', () => {
      expect(
        notificationText(
          {
            body: '',
            ranges: [],
            attachments: [],
            poll: {
              question: 'Where to eat?',
              options: ['a', 'b'],
              allowMultiple: false,
              votes: [],
            },
          },
          () => '',
        ),
      ).toBe('📊 Poll: Where to eat?');
    });

    it('notifies for a new poll like any message, with the question', () => {
      const { shown, receive } = setup();
      receive({
        body: '',
        poll: { question: 'Where to eat?', options: ['a', 'b'], allowMultiple: true, votes: [] },
      });
      expect(shown[0]?.body).toBe('Ana Lima: 📊 Poll: Where to eat?');
    });
  });
});
