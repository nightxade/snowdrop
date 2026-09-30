import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYBINDS } from './defaults';
import {
  formatKeybind,
  isMacPlatform,
  keybindFromEvent,
  matchesKeybind,
  parseKeybind,
  serializeKeybind,
  type KeyEventLike,
} from './keybind';
import {
  CommandRegistry,
  KeybindDispatcher,
  findKeybindConflicts,
  resolveKeybinds,
} from './registry';

const ev = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('keybind parsing', () => {
  it('parses modifiers and aliases', () => {
    expect(parseKeybind('Mod+Shift+K')).toEqual({
      key: 'k',
      mod: true,
      ctrl: false,
      meta: false,
      alt: false,
      shift: true,
    });
    expect(parseKeybind('alt+up')?.key).toBe('arrowup');
    expect(parseKeybind('Ctrl++')).toMatchObject({ key: '+', ctrl: true });
    expect(parseKeybind('Esc')?.key).toBe('escape');
    expect(parseKeybind('Hyper+K')).toBeNull();
    expect(parseKeybind('Mod+')).toBeNull();
    expect(parseKeybind('')).toBeNull();
  });

  it('parses every default keybind', () => {
    for (const kb of Object.values(DEFAULT_KEYBINDS)) expect(parseKeybind(kb)).not.toBeNull();
  });

  it('round-trips through serialisation', () => {
    for (const s of [
      'Mod+Shift+K',
      'Alt+Up',
      'Mod+,',
      'Shift+PageDown',
      'Escape',
      'Mod+/',
      'Ctrl+Space',
    ]) {
      const kb = parseKeybind(s)!;
      expect(parseKeybind(serializeKeybind(kb))).toEqual(kb);
    }
  });
});

describe('keybind matching', () => {
  const modK = parseKeybind('Mod+K')!;

  it('maps Mod to Cmd on macOS and Ctrl elsewhere', () => {
    expect(matchesKeybind(ev('k', { metaKey: true }), modK, true)).toBe(true);
    expect(matchesKeybind(ev('k', { ctrlKey: true }), modK, true)).toBe(false);
    expect(matchesKeybind(ev('k', { ctrlKey: true }), modK, false)).toBe(true);
    expect(matchesKeybind(ev('k', { metaKey: true }), modK, false)).toBe(false);
  });

  it('requires exact modifiers', () => {
    expect(matchesKeybind(ev('K', { ctrlKey: true, shiftKey: true }), modK, false)).toBe(false);
    expect(
      matchesKeybind(
        ev('K', { ctrlKey: true, shiftKey: true }),
        parseKeybind('Mod+Shift+K')!,
        false,
      ),
    ).toBe(true);
  });

  it('falls back to the physical key code (Alt on macOS, shifted symbols)', () => {
    expect(
      matchesKeybind(ev('˚', { altKey: true, code: 'KeyK' }), parseKeybind('Alt+K')!, true),
    ).toBe(true);
    expect(
      matchesKeybind(
        ev('?', { ctrlKey: true, shiftKey: true, code: 'Slash' }),
        parseKeybind('Mod+Shift+/')!,
        false,
      ),
    ).toBe(true);
  });

  it('records keybinds from events', () => {
    expect(keybindFromEvent(ev('Shift', { shiftKey: true }), false)).toBeNull();
    const kb = keybindFromEvent(ev('K', { metaKey: true, shiftKey: true, code: 'KeyK' }), true)!;
    expect(serializeKeybind(kb)).toBe('Mod+Shift+K');
  });

  it('formats per platform', () => {
    const kb = parseKeybind('Mod+Shift+K')!;
    expect(formatKeybind(kb, true)).toBe('⇧⌘K');
    expect(formatKeybind(kb, false)).toBe('Ctrl+Shift+K');
    expect(formatKeybind(parseKeybind('Alt+Up')!, false)).toBe('Alt+↑');
  });

  it('detects mac platforms', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false);
  });
});

describe('CommandRegistry', () => {
  it('registers, rejects duplicates and disposes', () => {
    const reg = new CommandRegistry();
    const listener = vi.fn();
    reg.subscribe(listener);
    const off = reg.register({ id: 'a', title: 'A', run: () => undefined }, 'plugin-x');
    expect(reg.get('a')?.owner).toBe('plugin-x');
    expect(() => reg.register({ id: 'a', title: 'dup', run: () => undefined })).toThrow(/already/u);
    off();
    expect(reg.all()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('executes with error isolation and respects enabled()', async () => {
    const onError = vi.fn();
    const reg = new CommandRegistry(onError);
    reg.register({ id: 'boom', title: 'Boom', run: () => Promise.reject(new Error('x')) });
    reg.register({ id: 'off', title: 'Off', enabled: () => false, run: vi.fn() });
    expect(await reg.execute('boom')).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(await reg.execute('off')).toBe(false);
    expect(await reg.execute('missing')).toBe(false);
  });

  it('resolves overrides and finds conflicts', () => {
    const commands = [
      { id: 'a', title: 'A', keybind: 'Mod+K', run: () => undefined },
      { id: 'b', title: 'B', keybind: 'Mod+J', run: () => undefined },
      { id: 'c', title: 'C', keybind: 'Mod+L', run: () => undefined },
    ];
    const bindings = resolveKeybinds(commands, { b: 'Mod+K', c: '' });
    expect([...bindings.keys()]).toEqual(['a', 'b']);
    expect(findKeybindConflicts(bindings)).toEqual([['a', 'b']]);
  });
});

describe('KeybindDispatcher', () => {
  it('dispatches matching commands, honouring editable focus', () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    const inInputs = vi.fn();
    reg.register({ id: 'toggle', title: 'Toggle', keybind: 'Mod+Shift+M', run });
    reg.register({
      id: 'switcher',
      title: 'Switcher',
      keybind: 'Mod+K',
      allowInInputs: true,
      run: inInputs,
    });
    let overrides: Record<string, string> = {};
    const d = new KeybindDispatcher(reg, () => overrides, false);

    expect(d.handle(ev('M', { ctrlKey: true, shiftKey: true }), { inEditable: false })).toBe(
      'toggle',
    );
    expect(run).toHaveBeenCalledOnce();
    expect(d.handle(ev('M', { ctrlKey: true, shiftKey: true }), { inEditable: true })).toBeNull();
    expect(d.handle(ev('k', { ctrlKey: true }), { inEditable: true })).toBe('switcher');

    overrides = { toggle: 'Alt+M' };
    expect(d.handle(ev('M', { ctrlKey: true, shiftKey: true }), { inEditable: false })).toBeNull();
    expect(d.handle(ev('m', { altKey: true }), { inEditable: false })).toBe('toggle');
  });
});
