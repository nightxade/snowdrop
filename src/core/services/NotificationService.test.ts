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
  type ReactionActivityEvent,
} from './NotificationService';

const NOW = 1_000_000;
const group = conversationIdFor('g');
const dm = directConversationId('ana');
const requestDm = directConversationId('eve');
const requestGroup = conversationIdFor('spam-group');

function setup(
  options: {
    permission?: NotificationPermissionState;
    visible?: boolean;
    /** A platform that answers `permission()` only once this has resolved. */
    loading?: Promise<void>;
  } = {},
) {
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
  let loaded = options.loading === undefined;
  void options.loading?.then(() => {
    loaded = true;
  });
  const api: NotificationApi = {
    permission: () => (loaded ? permission : 'default'),
    whenReady: () => (loaded ? null : (options.loading ?? null)),
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
    messageArrived: { message: Message; live: boolean; serverAt?: number };
    pollActivity: PollActivityEvent;
    reactionActivity: ReactionActivityEvent;
    messageRemoved: { message: Message };
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
  const receive = (partial: Partial<Message>, live = true, serverAt?: number) => {
    source.emit('messageArrived', {
      live,
      ...(serverAt === undefined ? {} : { serverAt }),
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
    serverAt?: number,
  ) => {
    source.emit('pollActivity', {
      kind,
      actorId,
      live,
      ...(serverAt === undefined ? {} : { serverAt }),
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
  const reactionActivity = (
    kind: ReactionActivityEvent['kind'],
    actorId: string,
    emoji: string,
    partial: Partial<Message> = {},
    live = true,
    at = NOW,
    serverAt?: number,
  ) => {
    source.emit('reactionActivity', {
      kind,
      actorId,
      emoji,
      at,
      live,
      ...(serverAt === undefined ? {} : { serverAt }),
      message: makeMessage({
        conversationId: group,
        authorId: 'me',
        sentAt: NOW,
        body: 'Where to eat?',
        ...partial,
      }),
    });
  };
  const removed = (message: Message) => {
    source.emit('messageRemoved', { message });
  };
  return {
    stores,
    service,
    shown,
    closed,
    receive,
    pollActivity,
    reactionActivity,
    removed,
    focusWindow,
    boost,
  };
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

  it('dates a message by when the server got it, not by the sender’s clock', () => {
    const { shown, receive } = setup();
    // Written before launch, but the server only took it after: new.
    receive({ sentAt: NOW - 60_000 }, true, NOW + 5);
    expect(shown).toHaveLength(1);
    // Sent after launch by a fast clock, but the server took it before: queued while offline.
    receive({ sentAt: NOW + 60_000, body: 'queued' }, true, NOW - 5);
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

  it('only the notification hold decides, not the sidebar catch-up flag', () => {
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
    ).toBe('Photo');
    expect(
      notificationText(
        {
          body: '',
          ranges: [],
          attachments: [{ id: 'a', contentType: 'application/pdf', fileName: 'plan.pdf' }],
        },
        () => '',
      ),
    ).toBe('plan.pdf');
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

  describe('before the platform has loaded', () => {
    it('holds a notification until the platform has answered, then shows it', async () => {
      let load: () => void = () => undefined;
      const loading = new Promise<void>((resolve) => {
        load = resolve;
      });
      const { shown, receive } = setup({ loading });
      receive({ sentAt: NOW + 1 });
      expect(shown).toHaveLength(0);
      load();
      await loading;
      await Promise.resolve();
      expect(shown).toHaveLength(1);
      expect(shown[0]?.body).toBe('Ana Lima: hello');
    });
  });

  describe('replayed activity', () => {
    it('dates a reaction and a poll vote by when the server got it', () => {
      const { shown, reactionActivity, pollActivity } = setup();
      // The reaction was made before launch, but the server only took it after.
      reactionActivity('react', 'ana', '👍', {}, true, NOW - 60_000, NOW + 5);
      expect(shown).toHaveLength(1);
      // Made after launch by the sender's clock, but the server took it before.
      reactionActivity('react', 'bo', '❤️', {}, true, NOW + 60_000, NOW - 5);
      pollActivity('vote', 'bo', {}, true, NOW - 5);
      expect(shown).toHaveLength(1);
      pollActivity('vote', 'bo', {}, true, NOW + 5);
      expect(shown).toHaveLength(2);
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
  describe('reactions (as Signal Desktop words them)', () => {
    it('names the reactor, the emoji and the message that was reacted to', () => {
      const { shown, reactionActivity } = setup();
      reactionActivity('react', 'ana', '👍');
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({
        title: 'Climbing',
        body: 'Ana Lima reacted 👍 to: Where to eat?',
        tag: `snowdrop:${group}`,
      });
    });

    it('titles a direct chat with the person, and never reveals a spoiler', () => {
      const { shown, reactionActivity } = setup();
      reactionActivity('react', 'ana', '❤️', {
        conversationId: dm,
        body: 'the end: he dies',
        ranges: [{ start: 9, length: 7, style: 'spoiler' }],
      });
      expect(shown[0]).toMatchObject({
        title: 'Ana Lima',
        body: 'Ana Lima reacted ❤️ to: the end: ▒▒▒▒',
      });
    });

    it('follows the same rules as a message: viewing, mute, mentions-only, switches', () => {
      const { stores, shown, reactionActivity } = setup();
      stores.ui.getState().selectConversation(group, HOME);
      reactionActivity('react', 'ana', '👍');
      expect(shown).toHaveLength(0);
      stores.ui.getState().setWindowFocused(false);
      stores.local.getState().setMuted(group, true);
      reactionActivity('react', 'ana', '👍');
      expect(shown).toHaveLength(0);
      stores.local.getState().setMuted(group, false);
      stores.settings.getState().update('notifications', { mode: 'mentions' });
      reactionActivity('react', 'ana', '👍');
      expect(shown).toHaveLength(0);
      stores.settings.getState().update('notifications', { mode: 'all', enabled: false });
      reactionActivity('react', 'ana', '👍');
      expect(shown).toHaveLength(0);
      stores.settings.getState().update('notifications', { enabled: true });
      reactionActivity('react', 'ana', '👍');
      expect(shown).toHaveLength(1);
    });

    it('never reveals the message when previews are off, nor to an unaccepted request', () => {
      const { stores, shown, reactionActivity } = setup();
      stores.settings.getState().update('notifications', { showPreview: false });
      reactionActivity('react', 'ana', '👍');
      expect(shown[0]?.body).toBe('New message');
      stores.settings.getState().update('notifications', { showPreview: true });
      reactionActivity('react', 'eve', '👍', { conversationId: requestDm });
      expect(shown[1]).toMatchObject({ title: 'Eve Stranger', body: 'Message Request' });
    });

    it('stays silent while notifications are held for a catch-up, then speaks again', () => {
      const { stores, shown, reactionActivity } = setup();
      stores.session.getState().setNotificationsHeld(true);
      reactionActivity('react', 'ana', '👍');
      expect(shown).toHaveLength(0);
      stores.session.getState().setNotificationsHeld(false);
      reactionActivity('react', 'ana', '👍');
      expect(shown).toHaveLength(1);
    });

    it('stays silent for old news, our own reactions, deleted messages and missing permission', () => {
      const { shown, reactionActivity } = setup();
      reactionActivity('react', 'ana', '👍', {}, false);
      reactionActivity('react', 'ana', '👍', {}, true, NOW - 1);
      reactionActivity('react', 'me', '👍');
      reactionActivity('react', 'ana', '👍', { deleted: true });
      reactionActivity('react', 'ana', '👍', { authorId: 'bo' });
      expect(shown).toHaveLength(0);
      const denied = setup({ permission: 'default' });
      denied.reactionActivity('react', 'ana', '👍');
      expect(denied.shown).toHaveLength(0);
    });

    it('withdraws it when the reaction is taken back', () => {
      const { shown, closed, reactionActivity } = setup();
      reactionActivity('react', 'ana', '👍');
      expect(closed).not.toHaveBeenCalled();
      reactionActivity('unreact', 'ana', '👍');
      expect(closed).toHaveBeenCalledOnce();
      expect(shown).toHaveLength(1);
    });

    it('withdraws it when the reaction is replaced, and announces the new one', () => {
      const { shown, closed, reactionActivity } = setup();
      reactionActivity('react', 'ana', '👍');
      reactionActivity('react', 'ana', '❤️');
      // One close for the withdrawal; the replacement's own notification takes the tag over.
      expect(closed).toHaveBeenCalledOnce();
      expect(shown.map((n) => n.body)).toEqual([
        'Ana Lima reacted 👍 to: Where to eat?',
        'Ana Lima reacted ❤️ to: Where to eat?',
      ]);
    });

    it('leaves another person’s, or another message’s, reaction notification up', () => {
      const { closed, reactionActivity } = setup();
      reactionActivity('react', 'ana', '👍');
      reactionActivity('unreact', 'bo', '👍');
      reactionActivity('unreact', 'ana', '👍', { sentAt: NOW + 5 });
      expect(closed).not.toHaveBeenCalled();
    });

    it('does not withdraw a message notification for a reaction taken back', () => {
      const { closed, receive, reactionActivity } = setup();
      receive({});
      reactionActivity('unreact', 'ana', '👍');
      expect(closed).not.toHaveBeenCalled();
    });
  });

  describe('withdrawing a notification that no longer applies', () => {
    it('closes a message notification once the chat is read past it, here or on the phone', () => {
      const { stores, closed, receive } = setup();
      receive({ seq: 7 });
      stores.conversations.getState().setReadCursors({ [group]: 6 });
      expect(closed).not.toHaveBeenCalled();
      stores.conversations.getState().setReadCursors({ [group]: 7 });
      expect(closed).toHaveBeenCalledOnce();
      // Nothing left to withdraw.
      stores.conversations.getState().setReadCursors({ [group]: 8 });
      expect(closed).toHaveBeenCalledOnce();
    });

    it('leaves a newer message’s notification when an older one is read', () => {
      const { stores, closed, receive } = setup();
      receive({ seq: 9, sentAt: NOW + 1 });
      stores.conversations.getState().setReadCursors({ [group]: 5 });
      expect(closed).not.toHaveBeenCalled();
    });

    it('leaves another conversation’s notification up', () => {
      const { stores, closed, receive } = setup();
      receive({ seq: 7 });
      stores.conversations.getState().setReadCursors({ [dm]: 50 });
      expect(closed).not.toHaveBeenCalled();
    });

    it('closes a reaction notification once its unread activity is cleared', () => {
      const { stores, closed, reactionActivity } = setup();
      stores.local.getState().noteUnreadActivity(group, NOW);
      reactionActivity('react', 'ana', '👍');
      stores.local.getState().noteUnreadActivity(group, NOW + 9);
      expect(closed).not.toHaveBeenCalled();
      stores.local.getState().dropUnreadActivity(NOW);
      expect(closed).toHaveBeenCalledOnce();
    });

    it('closes a vote notification when the chat is read', () => {
      const { stores, closed, pollActivity } = setup();
      stores.local.getState().noteUnreadActivity(group, NOW);
      pollActivity('vote', 'ana');
      stores.local.getState().dropUnreadActivity(NOW);
      expect(closed).toHaveBeenCalledOnce();
    });

    it('closes a poll-ended notification once the chat is read past the line', () => {
      const { stores, closed, pollActivity } = setup();
      stores.conversations.getState().noteLatest(makeMessage({ conversationId: group, seq: 12 }));
      pollActivity('end', 'bo', { authorId: 'bo' });
      stores.conversations.getState().setReadCursors({ [group]: 12 });
      expect(closed).toHaveBeenCalledOnce();
    });

    it('closes the notification of a message that was deleted or expired', () => {
      const a = setup();
      a.receive({ sentAt: NOW + 1 });
      a.removed(makeMessage({ conversationId: group, authorId: 'ana', sentAt: NOW + 1 }));
      expect(a.closed).toHaveBeenCalledOnce();
      const b = setup();
      b.reactionActivity('react', 'ana', '👍');
      b.removed(makeMessage({ conversationId: group, authorId: 'me', sentAt: NOW }));
      expect(b.closed).toHaveBeenCalledOnce();
      const c = setup();
      c.receive({ sentAt: NOW + 1 });
      c.removed(makeMessage({ conversationId: group, authorId: 'ana', sentAt: NOW + 2 }));
      expect(c.closed).not.toHaveBeenCalled();
    });

    it('stops watching when stopped', () => {
      const { stores, service, closed, receive } = setup();
      receive({ seq: 7 });
      service.stop();
      closed.mockClear();
      stores.conversations.getState().setReadCursors({ [group]: 9 });
      expect(closed).not.toHaveBeenCalled();
    });
  });

  describe('a conversation the stores do not list yet', () => {
    const fresh = conversationIdFor('not-listed-yet');

    it('is judged a message request: no text, the sender and "a group" in the title', () => {
      const { shown, receive } = setup();
      receive({ conversationId: fresh, authorId: 'ana', body: 'click this link' });
      expect(shown[0]).toMatchObject({ title: 'Ana Lima in a group', body: 'Message Request' });
    });

    it('is still a group for "mentions only"', () => {
      const { stores, shown, receive } = setup();
      stores.settings.getState().update('notifications', { mode: 'mentions' });
      receive({ conversationId: fresh, authorId: 'ana' });
      expect(shown).toHaveLength(0);
      receive({ conversationId: fresh, authorId: 'ana', sentAt: NOW + 1, ...mention('me') });
      expect(shown).toHaveLength(1);
    });

    it('shows the text once the user accepted it here', () => {
      const { stores, shown, receive } = setup();
      stores.local.getState().markAccepted(fresh, NOW);
      receive({ conversationId: fresh, authorId: 'ana', body: 'hello' });
      expect(shown[0]?.body).toBe('Ana Lima: hello');
    });
  });
});
