import { describe, expect, it, vi } from 'vitest';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { directConversationId, type Conversation, type Message } from '@/core/domain';
import { createStores } from '@/core/stores';
import { Registries } from './registries';
import { PluginRuntime } from './runtime';
import {
  defineExtension,
  type MessageArrival,
  type PluginContext,
  type PluginHost,
  type PluginMessageActions,
} from './types';

const conv = conversationIdFor('c');

function setup(start: (ctx: PluginContext) => void) {
  const stores = createStores();
  const onError = vi.fn();
  const listeners = new Set<(m: Message, a: MessageArrival) => void>();
  const reply = vi.fn();
  const react = vi.fn(() => Promise.resolve());
  const copy = vi.fn(() => Promise.resolve());
  const messages: PluginMessageActions = { reply, react, copy };
  const host: PluginHost = {
    stores,
    toast: vi.fn(),
    onError,
    messages,
    backend: {
      kind: 'mock',
      status: () => 'online',
      sendText: vi.fn(() => Promise.resolve()),
      onMessage: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
  // As in the app: registry errors are reported and recorded on the plugin.
  let runtime: PluginRuntime | null = null;
  const registries = new Registries((error, owner, where) => {
    onError(error, owner, where);
    runtime?.reportRuntimeError(owner, error, where);
  });
  const plugin = defineExtension({
    id: 'p',
    name: 'P',
    description: '',
    authors: [],
    enabledByDefault: true,
    start,
  });
  runtime = new PluginRuntime(host, registries, [plugin]);
  const emit = (m: Message, live: boolean) => {
    for (const fn of listeners) fn(m, { live });
  };
  return { runtime, registries, stores, onError, actions: { reply, react, copy }, emit };
}

describe('plugin API (P6)', () => {
  it('types slot components by their props', async () => {
    const { runtime, registries } = setup((ctx) => {
      ctx.messages.addDecoration('ok', ({ message }: { message: Message }) => message.body);
      ctx.composer.addAccessory('ok', ({ conversationId, descriptionId }) => [
        conversationId,
        descriptionId,
      ]);
      const wrongProps = ({ conversationId }: { conversationId: string }) => conversationId;
      // @ts-expect-error a decoration receives { message }, not { conversationId }
      ctx.messages.addDecoration('bad', wrongProps);
      // @ts-expect-error a composer accessory receives no message
      ctx.composer.addAccessory('bad', ({ message }: { message: Message }) => message);
      // @ts-expect-error icons must be components
      ctx.headerBar.addButton({ id: 'b', label: 'B', icon: 'x', onClick: () => undefined });
    });
    await runtime.startAll();
    const deco = registries.messageDecorations.list()[0];
    expect(deco?.component({ message: makeMessage({ body: 'hi' }) })).toBe('hi');
  });

  it('runs message actions through the host, not the focused row', async () => {
    const message = makeMessage({ conversationId: conv, body: 'x' });
    let ctx!: PluginContext;
    const { runtime, actions } = setup((c) => {
      ctx = c;
    });
    await runtime.startAll();
    ctx.messages.reply(message);
    await ctx.messages.react(message, '👍');
    await ctx.messages.copy(message);
    expect(actions.reply).toHaveBeenCalledWith(message);
    expect(actions.react).toHaveBeenCalledWith(message, '👍');
    expect(actions.copy).toHaveBeenCalledWith(message);
  });

  it('gives plugins a small observable state, dropped on stop', async () => {
    let ctx!: PluginContext;
    const { runtime } = setup((c) => {
      ctx = c;
    });
    await runtime.startAll();
    const away = ctx.state(false);
    const seen: boolean[] = [];
    away.subscribe((v) => seen.push(v));
    away.set(true);
    away.set(true); // unchanged: no notification
    away.set((v) => !v);
    expect(away.get()).toBe(false);
    expect(seen).toEqual([true, false]);
    await runtime.setEnabled('p', false);
    away.set(true);
    expect(seen).toEqual([true, false]);
  });

  it('isolates a throwing state listener', async () => {
    let ctx!: PluginContext;
    const { runtime, onError } = setup((c) => {
      ctx = c;
    });
    await runtime.startAll();
    const s = ctx.state(0);
    const good = vi.fn();
    s.subscribe(() => {
      throw new Error('listener');
    });
    s.subscribe(good);
    s.set(1);
    expect(good).toHaveBeenCalledWith(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'p', 'state listener');
  });

  it('tells onMessage whether a message arrived live', async () => {
    const arrivals: boolean[] = [];
    const { runtime, emit } = setup((ctx) => {
      ctx.backend.onMessage((_m, { live }) => arrivals.push(live));
    });
    await runtime.startAll();
    emit(makeMessage(), false);
    emit(makeMessage(), true);
    expect(arrivals).toEqual([false, true]);
  });

  it('looks up conversations read-only, and knows direct ones before they sync', async () => {
    let ctx!: PluginContext;
    const { runtime, stores } = setup((c) => {
      ctx = c;
    });
    const group: Conversation = {
      id: conversationIdFor('g'),
      kind: 'group',
      title: 'G',
      memberIds: [],
      adminIds: [],
      expireTimerSec: 0,
      lastActivityAt: 0,
    };
    stores.conversations.getState().upsert(group);
    await runtime.startAll();
    expect(ctx.conversations.get(group.id)?.title).toBe('G');
    expect(ctx.conversations.isDirect(group.id)).toBe(false);
    expect(ctx.conversations.isDirect(directConversationId('someone'))).toBe(true);
    expect(ctx.conversations.get(conversationIdFor('nobody'))).toBeUndefined();
  });

  it('reports hover action, menu and header failures against the plugin, sync or async', async () => {
    const { runtime, registries, onError } = setup((ctx) => {
      ctx.messages.addHoverAction({
        id: 'h',
        label: 'H',
        icon: () => null,
        onClick: () => {
          throw new Error('click');
        },
      });
      ctx.menus.add('message', {
        id: 'm',
        label: 'M',
        onSelect: () => Promise.reject(new Error('select')),
        visible: () => {
          throw new Error('visible');
        },
      });
    });
    await runtime.startAll();
    const action = registries.hoverActions.list()[0]!;
    const item = registries.menus.message.list()[0]!;
    const message = makeMessage();
    registries.invoke(action, 'hover action', () => action.onClick(message));
    registries.invoke(item, 'menu item', () => item.onSelect(message));
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'p', 'hover action "h"');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'p', 'menu item "m"');
    // A throwing visible() hides the item and is reported once, not per render.
    expect(registries.isVisible(item, message, 'menu item')).toBe(false);
    expect(registries.isVisible(item, message, 'menu item')).toBe(false);
    expect(onError.mock.calls.filter((c) => String(c[2]).endsWith('visible()'))).toHaveLength(1);
    // The card shows the latest failure; Retry restarts the plugin and clears it.
    expect(runtime.get('p')?.runtimeError?.where).toBe('menu item "m" visible()');
    await runtime.retry('p');
    expect(runtime.get('p')?.status).toBe('running');
    expect(runtime.get('p')?.runtimeError).toBeUndefined();
  });

  it('attributes command failures to the owning plugin', async () => {
    const { runtime, registries, onError } = setup((ctx) => {
      ctx.commands.register({
        id: 'p.boom',
        title: 'Boom',
        run: () => {
          throw new Error('boom');
        },
      });
    });
    await runtime.startAll();
    expect(await registries.commands.execute('p.boom')).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'p', 'command "p.boom"');
    expect(runtime.get('p')?.runtimeError?.where).toBe('command "p.boom"');
  });

  it('registers and tears down a status-line item (TUI shell)', async () => {
    const { runtime, registries } = setup((ctx) => {
      ctx.statusBar.addItem('mode', () => 'NORMAL');
    });
    await runtime.startAll();
    const entry = registries.statusItems.list()[0];
    expect(entry).toMatchObject({ id: 'mode', owner: 'p' });
    expect((entry?.component as () => string)()).toBe('NORMAL');
    await runtime.stop('p');
    expect(registries.statusItems.list()).toEqual([]);
  });
});
