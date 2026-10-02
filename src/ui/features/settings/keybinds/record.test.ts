import { describe, expect, it } from 'vitest';
import type { KeyEventLike } from '@/core/commands';
import { keybindConflicts, keybindProblem, recordKey } from './record';

const ev = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('keybind recorder', () => {
  it('records portable bindings and keeps listening on bare modifiers', () => {
    expect(recordKey(ev('Control', { ctrlKey: true }), false)).toBeNull();
    expect(recordKey(ev('k', { ctrlKey: true, code: 'KeyK' }), false)).toEqual({
      type: 'set',
      keybind: 'Mod+K',
    });
    expect(recordKey(ev('k', { metaKey: true, code: 'KeyK' }), true)).toEqual({
      type: 'set',
      keybind: 'Mod+K',
    });
    expect(recordKey(ev('ArrowUp', { altKey: true, shiftKey: true }), false)).toEqual({
      type: 'set',
      keybind: 'Alt+Shift+Up',
    });
  });

  it('cancels on Escape or Tab and unbinds on Backspace/Delete', () => {
    expect(recordKey(ev('Escape'), false)).toEqual({ type: 'cancel' });
    expect(recordKey(ev('Tab'), false)).toEqual({ type: 'cancel' });
    expect(recordKey(ev('Backspace'), false)).toEqual({ type: 'unbind' });
    expect(recordKey(ev('Delete'), false)).toEqual({ type: 'unbind' });
    // With a modifier these are ordinary shortcuts.
    expect(recordKey(ev('Escape', { shiftKey: true }), false)).toEqual({
      type: 'set',
      keybind: 'Shift+Escape',
    });
  });

  it('rejects plain keys for commands that also run while typing', () => {
    expect(keybindProblem('K', { allowInInputs: true })).toMatch(/Ctrl, Alt or Cmd/u);
    expect(keybindProblem('K', {})).toBeNull();
    expect(keybindProblem('Mod+K', { allowInInputs: true })).toBeNull();
    expect(keybindProblem('F2', { allowInInputs: true })).toBeNull();
  });

  it('reports conflicts after overrides, both ways', () => {
    const commands = [
      { id: 'a', title: 'A', keybind: 'Mod+K', run: () => undefined },
      { id: 'b', title: 'B', keybind: 'Mod+J', run: () => undefined },
      { id: 'c', title: 'C', run: () => undefined },
    ];
    expect(keybindConflicts(commands, {}).size).toBe(0);
    const clash = keybindConflicts(commands, { b: 'Mod+K', c: 'Mod+K' });
    expect(clash.get('a')).toEqual(['b', 'c']);
    expect(clash.get('c')).toEqual(['a', 'b']);
    // Unbinding resolves it.
    expect(keybindConflicts(commands, { b: '' }).size).toBe(0);
  });
});
