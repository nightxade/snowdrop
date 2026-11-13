import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootForward } from '@/test/forwardKit';
import { renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { directConversationId, messageId, type Message } from '@/core/domain';
import { createStores } from '@/core/stores';
import type { AppServices } from '@/ui/hooks';
import { ChatController } from '../ChatController';
import {
  MESSAGE_ACTIONS,
  messageActionEnabled,
  permissionsFor,
  runMessageAction,
  type ActionContext,
  type MessageActionId,
} from './actions';
import { HoverBar } from './HoverBar';
import { buildMessageMenu } from './messageMenu';

const PEER = 'peer-aci';
const id = directConversationId(PEER);

function setup(accepted: boolean) {
  const stores = createStores();
  stores.session.getState().setSelf({ id: 'me', name: 'Me', color: '#000', isSelf: true });
  stores.contacts.getState().upsert({ id: PEER, name: 'Peer', color: '#111' });
  stores.conversations.getState().upsert({
    id,
    kind: 'direct',
    title: 'Peer',
    memberIds: ['me', PEER],
    adminIds: [],
    expireTimerSec: 0,
    lastActivityAt: 1,
  });
  if (accepted) stores.local.getState().markAccepted(id, 1);
  return {
    stores,
    send: { capabilities: { adminDelete: false, pin: true, polls: true } },
    backend: { capabilities: { features: new Set<string>() } },
    registries: { menus: { message: { list: () => [] } }, isVisible: () => true },
  } as unknown as AppServices;
}

const base: Message = {
  id: messageId(PEER, 1),
  conversationId: id,
  authorId: PEER,
  sentAt: Date.now(),
  receivedAt: Date.now(),
  body: 'hi',
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'read',
  kind: 'normal',
};

const noop = () => undefined;
const menuIds = (app: AppServices, m: Message) =>
  buildMessageMenu(app, new ChatController(), m, {
    openPicker: noop,
    requestDelete: noop,
    openDetails: noop,
    requestEndPoll: noop,
    openStickerPack: noop,
    openCustomEmoji: noop,
  }).map((e) => e.id);

/** The menu entry that stands for each table action, where it has one. */
const MENU_ID: Partial<Record<MessageActionId, string>> = {
  retry: 'retry',
  react: 'react',
  reply: 'reply',
  forward: 'forward',
  edit: 'edit',
  details: 'details',
  copyText: 'copy',
  deleteMe: 'delete-me',
  deleteEveryone: 'delete-everyone',
};

describe('the message action table', () => {
  it('has a failed send offer retry and not edit, reply or react', () => {
    const app = setup(true);
    const m: Message = { ...base, id: messageId('me', 2), authorId: 'me', status: 'failed' };
    const p = permissionsFor(app, m);
    expect(messageActionEnabled('retry', p, m)).toBe(true);
    expect(messageActionEnabled('edit', p, m)).toBe(false);
    expect(messageActionEnabled('reply', p, m)).toBe(false);
    expect(messageActionEnabled('delete', p, m)).toBe(false);
    const ids = menuIds(app, m);
    expect(ids).toContain('retry');
    expect(ids).not.toContain('edit');
    expect(ids).not.toContain('reply');
  });

  it('offers no reply, react or forward in a message request', () => {
    const app = setup(false);
    const p = permissionsFor(app, base);
    for (const a of ['reply', 'react', 'forward', 'pin'] as const) {
      expect(messageActionEnabled(a, p, base)).toBe(false);
    }
    const ids = menuIds(app, base);
    expect(ids).not.toContain('reply');
    expect(ids).not.toContain('react');
    expect(ids).toContain('delete-me');
  });

  it.each([
    ['received, accepted', true, base],
    ['own, accepted', true, { ...base, id: messageId('me', 3), authorId: 'me' }],
    ['request', false, base],
  ])('the menu offers exactly what the table enables: %s', (_name, accepted, m) => {
    const app = setup(accepted);
    const p = permissionsFor(app, m);
    const ids = menuIds(app, m);
    for (const [action, menuId] of Object.entries(MENU_ID)) {
      expect(ids.includes(menuId), action).toBe(
        MESSAGE_ACTIONS[action as MessageActionId].enabled(p, m),
      );
    }
  });

  it('drives the menu from the table entry, not from its own gate', () => {
    const app = setup(true);
    const pin = MESSAGE_ACTIONS.pin;
    const original = { ...pin };
    try {
      pin.enabled = () => false;
      expect(menuIds(app, base)).not.toContain('pin');
      pin.enabled = () => true;
      const run = vi.fn(() => true);
      pin.run = run;
      const entries = buildMessageMenu(app, new ChatController(), base, {
        openPicker: noop,
        requestDelete: noop,
        openDetails: noop,
        requestEndPoll: noop,
        openStickerPack: noop,
        openCustomEmoji: noop,
      });
      const entry = entries.find((e) => e.id === 'pin');
      expect(entry?.kind).toBe('item');
      if (entry?.kind === 'item') entry.onSelect();
      expect(run).toHaveBeenCalledOnce();
    } finally {
      Object.assign(pin, original);
    }
  });

  it('swaps pin for unpin on a pinned message', () => {
    const app = setup(true);
    expect(menuIds(app, base)).toContain('pin');
    const pinned = { ...base, pinned: true };
    expect(menuIds(app, pinned)).toContain('unpin');
    expect(menuIds(app, pinned)).not.toContain('pin');
  });

  it('lets the command path try an own message that can no longer be edited', () => {
    const app = setup(true);
    const old: Message = {
      ...base,
      id: messageId('me', 4),
      authorId: 'me',
      sentAt: Date.now() - 48 * 3_600_000,
    };
    const p = permissionsFor(app, old);
    expect(messageActionEnabled('edit', p, old)).toBe(false);
    const ctx = { app, chat: new ChatController(), m: old, p } as unknown as ActionContext;
    // It is attempted (and startEdit says why not); it just does not succeed.
    expect(runMessageAction('edit', ctx, 'command')).toBe(false);
    expect(MESSAGE_ACTIONS.edit.commandEnabled?.(p, old)).toBe(true);
  });
});

describe('the hover bar', () => {
  afterEach(cleanup);

  it('shows retry and no edit on a failed send', async () => {
    const kit = await bootForward();
    const { snowdrop } = kit;
    const self = snowdrop.stores.session.getState().self!.id;
    const m: Message = { ...kit.message, authorId: self, status: 'failed', sentAt: Date.now() };
    const p = permissionsFor(snowdrop, m);
    const ctx = { app: snowdrop, chat: new ChatController(), m, p } as unknown as ActionContext;
    renderWithSnowdrop(
      snowdrop,
      <HoverBar
        message={m}
        actions={ctx}
        pickerOpen={false}
        onPickerOpenChange={noop}
        menuOpen={false}
        onMenuOpenChange={noop}
        menu={() => []}
        onReact={noop}
      />,
    );
    await settle(snowdrop);
    expect(screen.getByRole('button', { name: /retry|send again/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await snowdrop.dispose();
  });
});
