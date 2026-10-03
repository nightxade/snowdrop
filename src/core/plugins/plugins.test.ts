import { describe, expect, it, vi } from 'vitest';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { createStores, type Stores } from '@/core/stores';
import type { OutgoingDraft } from '@/core/services';
import {
  cleanUrl,
  keywordAlertsPlugin,
  matchKeyword,
  slashBasicsPlugin,
  stripTrackingParams,
} from './builtin';
import { clearUrlsPlugin } from './builtin/clearUrls';
import { parseSlash, Registries } from './registries';
import { PluginRuntime } from './runtime';
import { coerceSetting, defineSettings, resolveSettings } from './settings';
import { definePlugin, type PluginDefinition, type PluginHost } from './types';

// Typing guards are still a plugin capability; Silent Typing itself became a
// Privacy setting (behaviour.sendTypingIndicators) in the P4 review.
const silentTypingPlugin = definePlugin({
  id: 'silent-typing',
  name: 'Silent Typing',
  description: 'Test plugin: suppresses typing indicators.',
  authors: ['test'],
  start(ctx) {
    ctx.send.addTypingGuard(() => false);
  },
});

const conv = conversationIdFor('c');
const draft = (text: string): OutgoingDraft => ({
  conversationId: conv,
  text,
  mentionIds: [],
  attachments: [],
});

function setup(plugins: readonly PluginDefinition[], stores: Stores = createStores()) {
  const onError = vi.fn();
  const toast = vi.fn();
  const messageListeners = new Set<
    (m: ReturnType<typeof makeMessage>, arrival: { live: boolean }) => void
  >();
  const host: PluginHost = {
    stores,
    toast,
    onError,
    backend: {
      kind: 'mock',
      status: () => 'online',
      sendText: vi.fn(() => Promise.resolve()),
      onMessage: (fn) => {
        messageListeners.add(fn);
        return () => messageListeners.delete(fn);
      },
    },
  };
  const registries = new Registries(onError);
  const runtime = new PluginRuntime(host, registries, plugins);
  const emitMessage = (m: ReturnType<typeof makeMessage>, live = true) => {
    for (const fn of messageListeners) fn(m, { live });
  };
  return { runtime, registries, stores, onError, toast, emitMessage, messageListeners };
}

describe('settings schema', () => {
  const schema = defineSettings({
    flag: { type: 'boolean', label: 'Flag', default: true },
    name: { type: 'string', label: 'Name', default: 'x', maxLength: 3 },
    count: { type: 'number', label: 'Count', default: 2, min: 0, max: 10 },
    mode: {
      type: 'select',
      label: 'Mode',
      default: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  });

  it('coerces untrusted stored values', () => {
    expect(resolveSettings(schema, { flag: 'yes', name: 'abcdef', count: 99, mode: 'z' })).toEqual({
      flag: true,
      name: 'abc',
      count: 10,
      mode: 'a',
    });
    expect(coerceSetting(schema.count, Number.NaN)).toBe(2);
    expect(coerceSetting(schema.mode, 'b')).toBe('b');
  });
});

describe('PluginRuntime lifecycle', () => {
  it('starts enabled plugins and disposes every registration on stop', async () => {
    const stop = vi.fn();
    const cleanup = vi.fn();
    const plugin = definePlugin({
      id: 'p',
      name: 'P',
      description: '',
      authors: [],
      enabledByDefault: true,
      start(ctx) {
        ctx.commands.register({ id: 'p.cmd', title: 'Cmd', run: () => undefined });
        ctx.slash.register({ name: 'Hello', description: '', execute: () => ({ type: 'done' }) });
        ctx.send.addTransform((d) => d);
        ctx.send.addTypingGuard(() => true);
        ctx.messages.addAccessory('a', () => null);
        ctx.messages.addDecoration('d', () => null);
        ctx.messages.addHoverAction({
          id: 'h',
          label: 'H',
          icon: () => null,
          onClick: () => undefined,
        });
        ctx.menus.add('message', { id: 'm', label: 'M', onSelect: () => undefined });
        ctx.headerBar.addButton({
          id: 'b',
          label: 'B',
          icon: () => null,
          onClick: () => undefined,
        });
        ctx.settingsPanels.add({ id: 's', title: 'S', component: () => null });
        ctx.styles.inject('.x { color: red }');
        ctx.onDispose(cleanup);
      },
      stop,
    });
    const { runtime, registries } = setup([plugin]);
    await runtime.startAll();
    expect(runtime.get('p')?.status).toBe('running');
    expect(registries.commands.get('p.cmd')?.owner).toBe('p');
    expect(registries.findSlash('hello')?.owner).toBe('p');
    expect(registries.combinedCss()).toContain('color: red');
    expect(registries.menus.message.list()).toHaveLength(1);

    await runtime.setEnabled('p', false);
    expect(stop).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(runtime.get('p')?.status).toBe('stopped');
    const lists = [
      registries.commands.all(),
      registries.slash.list(),
      registries.sendTransforms.list(),
      registries.typingGuards.list(),
      registries.messageAccessories.list(),
      registries.messageDecorations.list(),
      registries.hoverActions.list(),
      registries.menus.message.list(),
      registries.headerButtons.list(),
      registries.settingsPanels.list(),
      registries.styles.list(),
    ];
    for (const list of lists) expect(list).toHaveLength(0);
  });

  it('isolates a plugin that throws during start and undoes its partial registrations', async () => {
    const good = definePlugin({
      id: 'good',
      name: 'Good',
      description: '',
      authors: [],
      enabledByDefault: true,
      start(ctx) {
        ctx.commands.register({ id: 'good.cmd', title: 'Good', run: () => undefined });
      },
    });
    const bad = definePlugin({
      id: 'bad',
      name: 'Bad',
      description: '',
      authors: [],
      enabledByDefault: true,
      start(ctx) {
        ctx.commands.register({ id: 'bad.cmd', title: 'Bad', run: () => undefined });
        throw new Error('kaboom');
      },
    });
    const asyncBad = definePlugin({
      id: 'async-bad',
      name: 'Async bad',
      description: '',
      authors: [],
      enabledByDefault: true,
      async start() {
        await Promise.resolve();
        throw new Error('later');
      },
    });
    const { runtime, registries, onError } = setup([bad, good, asyncBad]);
    await runtime.startAll();
    expect(runtime.get('good')?.status).toBe('running');
    expect(runtime.get('bad')?.status).toBe('failed');
    expect(runtime.get('bad')?.error).toBeInstanceOf(Error);
    expect(runtime.get('async-bad')?.status).toBe('failed');
    expect(registries.commands.get('bad.cmd')).toBeUndefined();
    expect(registries.commands.get('good.cmd')).toBeDefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'bad', 'start');
  });

  it('still disposes when stop() throws', async () => {
    const plugin = definePlugin({
      id: 'p',
      name: 'P',
      description: '',
      authors: [],
      enabledByDefault: true,
      start(ctx) {
        ctx.styles.inject('a{}');
      },
      stop() {
        throw new Error('nope');
      },
    });
    const { runtime, registries, onError } = setup([plugin]);
    await runtime.startAll();
    await runtime.stop('p');
    expect(registries.styles.list()).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'p', 'stop');
  });

  it('persists enable state and follows external settings changes', async () => {
    const start = vi.fn();
    const plugin = definePlugin({ id: 'p', name: 'P', description: '', authors: [], start });
    const { runtime, stores } = setup([plugin]);
    await runtime.startAll();
    expect(runtime.isEnabled('p')).toBe(false);
    await runtime.setEnabled('p', true);
    expect(stores.settings.getState().plugins.p?.enabled).toBe(true);
    expect(start).toHaveBeenCalledOnce();

    stores.settings.getState().reset();
    await vi.waitFor(() => {
      expect(runtime.get('p')?.status).toBe('stopped');
    });
    await runtime.stopAll();
  });

  it('(H) does not restart a failed plugin when another plugin’s settings change', async () => {
    const start = vi.fn(() => {
      throw new Error('boom');
    });
    const bad = definePlugin({
      id: 'bad',
      name: 'Bad',
      description: '',
      authors: [],
      enabledByDefault: true,
      start,
    });
    const other = definePlugin({
      id: 'other',
      name: 'O',
      description: '',
      authors: [],
      enabledByDefault: true,
      start: () => undefined,
    });
    const { runtime, stores } = setup([bad, other]);
    await runtime.startAll();
    for (let i = 0; i < 3; i++) {
      stores.settings.getState().setPluginSetting('other', 'x', i);
      await Promise.resolve();
    }
    expect(start).toHaveBeenCalledOnce();
  });

  it('never disables required plugins', async () => {
    const plugin = definePlugin({
      id: 'core',
      name: 'Core',
      description: '',
      authors: [],
      required: true,
      start: vi.fn(),
    });
    const { runtime } = setup([plugin]);
    await runtime.startAll();
    await runtime.setEnabled('core', false);
    expect(runtime.get('core')?.status).toBe('running');
  });

  it('serialises rapid toggles', async () => {
    let running = 0;
    let maxRunning = 0;
    const plugin = definePlugin({
      id: 'p',
      name: 'P',
      description: '',
      authors: [],
      async start(ctx) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        ctx.onDispose(() => running--);
        await Promise.resolve();
      },
    });
    const { runtime } = setup([plugin]);
    await Promise.all([
      runtime.start('p'),
      runtime.start('p'),
      runtime.stop('p'),
      runtime.start('p'),
    ]);
    expect(maxRunning).toBe(1);
    expect(runtime.get('p')?.status).toBe('running');
  });

  it('exposes typed settings to the plugin and notifies on change', async () => {
    const seen: number[] = [];
    const plugin = definePlugin({
      id: 'p',
      name: 'P',
      description: '',
      authors: [],
      enabledByDefault: true,
      settings: defineSettings({
        level: { type: 'number', label: 'Level', default: 1, min: 0, max: 5 },
      }),
      start(ctx) {
        seen.push(ctx.settings.get('level'));
        ctx.settings.subscribe((v) => seen.push(v.level));
        ctx.settings.set('level', 42);
      },
    });
    const { runtime, stores } = setup([plugin]);
    await runtime.startAll();
    expect(seen).toEqual([1, 5]);
    expect(stores.settings.getState().plugins.p?.settings.level).toBe(5);
  });

  it('notifies subscribers with a stable snapshot', async () => {
    const plugin = definePlugin({
      id: 'p',
      name: 'P',
      description: '',
      authors: [],
      enabledByDefault: true,
      start: () => undefined,
    });
    const { runtime } = setup([plugin]);
    const snapshot = runtime.list();
    expect(runtime.list()).toBe(snapshot);
    const fn = vi.fn();
    runtime.subscribe(fn);
    await runtime.startAll();
    expect(fn).toHaveBeenCalled();
    expect(runtime.list()).not.toBe(snapshot);
  });

  it('rejects duplicate plugin ids and duplicate slash names', async () => {
    const a = definePlugin({
      id: 'a',
      name: 'A',
      description: '',
      authors: [],
      start: () => undefined,
    });
    expect(() => setup([a, a])).toThrow(/Duplicate/u);
    const s1 = definePlugin({
      id: 's1',
      name: 'S1',
      description: '',
      authors: [],
      enabledByDefault: true,
      start: (ctx) =>
        void ctx.slash.register({ name: 'x', description: '', execute: () => ({ type: 'done' }) }),
    });
    const s2 = definePlugin({
      id: 's2',
      name: 'S2',
      description: '',
      authors: [],
      enabledByDefault: true,
      start: (ctx) =>
        void ctx.slash.register({ name: 'X', description: '', execute: () => ({ type: 'done' }) }),
    });
    const { runtime } = setup([s1, s2]);
    await runtime.startAll();
    expect([runtime.get('s1')?.status, runtime.get('s2')?.status].sort()).toEqual([
      'failed',
      'running',
    ]);
  });
});

describe('Registries pipeline', () => {
  it('skips transforms that return malformed drafts or redirect the conversation', async () => {
    const onError = vi.fn<(error: unknown, owner: string, where: string) => void>();
    const r = new Registries(onError);
    r.sendTransforms.add({ owner: 'null', transform: () => null as unknown as OutgoingDraft });
    r.sendTransforms.add({
      owner: 'redirect',
      transform: (d) => ({ ...d, conversationId: conversationIdFor('elsewhere') }),
    });
    r.sendTransforms.add({
      owner: 'badtext',
      transform: (d) => ({ ...d, text: 42 as unknown as string }),
    });
    r.sendTransforms.add({ owner: 'ok', transform: (d) => ({ ...d, text: `${d.text}!` }) });
    const out = await r.transform(draft('x'));
    expect(out).toEqual(draft('x!'));
    expect(onError.mock.calls.map((c) => c[1])).toEqual(['null', 'redirect', 'badtext']);
  });

  it('runs transforms in order and skips a throwing one', async () => {
    const onError = vi.fn();
    const r = new Registries(onError);
    r.sendTransforms.add({ owner: 'a', transform: (d) => ({ ...d, text: `${d.text}1` }) });
    r.sendTransforms.add({
      owner: 'b',
      transform: () => {
        throw new Error('x');
      },
    });
    r.sendTransforms.add({
      owner: 'c',
      transform: (d) => Promise.resolve({ ...d, text: `${d.text}3` }),
    });
    expect((await r.transform(draft('x'))).text).toBe('x13');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'b', 'send transform');
  });

  it('combines typing guards, treating a throwing guard as permissive', () => {
    const r = new Registries(vi.fn());
    expect(r.allowsTyping(conv)).toBe(true);
    r.typingGuards.add({
      owner: 'a',
      guard: () => {
        throw new Error('x');
      },
    });
    expect(r.allowsTyping(conv)).toBe(true);
    r.typingGuards.add({ owner: 'b', guard: () => false });
    expect(r.allowsTyping(conv)).toBe(false);
  });

  it('parses slash invocations', () => {
    expect(parseSlash('/shrug hello there')).toEqual({ name: 'shrug', args: 'hello there' });
    expect(parseSlash('/ME')).toEqual({ name: 'me', args: '' });
    expect(parseSlash('not /a command')).toBeNull();
    expect(parseSlash('/')).toBeNull();
  });
});

describe('built-in plugins', () => {
  it('Clear URLs strips tracking params and keeps everything else', () => {
    expect(cleanUrl('https://example.com/a?utm_source=x&id=5&fbclid=abc')).toBe(
      'https://example.com/a?id=5',
    );
    expect(cleanUrl('https://example.com/?utm_medium=a')).toBe('https://example.com/');
    expect(cleanUrl('https://example.com/p?keep=1&ref=me', ['ref'])).toBe(
      'https://example.com/p?keep=1',
    );
    expect(cleanUrl('not a url')).toBe('not a url');
    expect(
      stripTrackingParams(
        'see (https://en.wikipedia.org/wiki/Foo_(bar)?utm_x=1). And https://x.io/?si=abc!',
      ),
    ).toBe('see (https://en.wikipedia.org/wiki/Foo_(bar)). And https://x.io/!');
    expect(stripTrackingParams('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });

  it('Clear URLs runs as a send transform honouring its settings', async () => {
    const { runtime, registries, stores } = setup([clearUrlsPlugin]);
    stores.settings.getState().setPluginSetting('clear-urls', 'extraParams', 'source_*');
    await runtime.startAll();
    const out = await registries.transform(draft('https://a.b/c?source_id=1&utm_campaign=z&q=ok'));
    expect(out.text).toBe('https://a.b/c?q=ok');
  });

  it('Silent Typing suppresses typing indicators', async () => {
    const { runtime, registries } = setup([silentTypingPlugin]);
    await runtime.setEnabled('silent-typing', true);
    expect(registries.allowsTyping(conv)).toBe(false);
    await runtime.setEnabled('silent-typing', false);
    expect(registries.allowsTyping(conv)).toBe(true);
  });

  it('Slash Basics produces markdown-safe output', async () => {
    const { runtime, registries, stores } = setup([slashBasicsPlugin]);
    await runtime.startAll();
    const run = async (name: string, args: string) =>
      registries.findSlash(name)!.execute(args, { conversationId: conv });
    expect(await run('shrug', 'oh well')).toEqual({
      type: 'send',
      text: 'oh well ¯\\\\\\_(ツ)\\_/¯',
      format: 'markdown',
    });
    // No profile yet: just the action.
    expect(await run('me', 'waves')).toEqual({ type: 'send', text: '_waves_', format: 'markdown' });
    stores.session.getState().setSelf({ id: 'me', name: 'Juniper_H', color: '' });
    expect(await run('me', 'waves')).toEqual({
      type: 'send',
      text: '_Juniper\\_H waves_',
      format: 'markdown',
    });
    expect(await run('spoiler', 'it was him')).toEqual({
      type: 'send',
      text: '||it was him||',
      format: 'markdown',
    });
    expect((await run('me', '')).type).toBe('error');
    expect((await run('tableflip', '')).type).toBe('send');
  });

  it('Keyword Alerts matches whole words and toasts', async () => {
    expect(matchKeyword('Deploying now', ['deploy'])).toBeNull();
    expect(matchKeyword('time to deploy!', [' deploy '])).toBe('deploy');
    expect(matchKeyword('anything', ['', ' '])).toBeNull();

    const stores = createStores();
    stores.session.getState().setSelf({ id: 'me', name: 'Me', color: '' });
    const { runtime, toast, emitMessage } = setup([keywordAlertsPlugin], stores);
    stores.settings.getState().setPluginSetting('keyword-alerts', 'keywords', 'lunch, climbing');
    await runtime.setEnabled('keyword-alerts', true);
    emitMessage(makeMessage({ conversationId: conv, authorId: 'a', body: 'Lunch at noon?' }));
    emitMessage(makeMessage({ conversationId: conv, authorId: 'me', body: 'lunch' }));
    expect(toast).toHaveBeenCalledOnce();
    expect(toast.mock.calls[0]?.[0]).toContain('lunch');
  });
});
