/**
 * Keybind recording and validation, pure so it's unit-tested. Recording uses
 * core's keybindFromEvent, which records exactly what the dispatcher will
 * match, on any keyboard layout.
 */
import {
  findKeybindConflicts,
  keybindFromEvent,
  parseKeybind,
  resolveKeybinds,
  serializeKeybind,
  type Command,
  type KeyEventLike,
} from '@/core/commands';

export type RecordOutcome =
  { type: 'cancel' } | { type: 'unbind' } | { type: 'set'; keybind: string };

/** null = keep listening (a bare modifier was pressed). */
export function recordKey(event: KeyEventLike, isMac: boolean): RecordOutcome | null {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (plain && event.key === 'Escape') return { type: 'cancel' };
  // Tab keeps moving focus: a shortcut on Tab would trap keyboard users.
  if (plain && event.key === 'Tab') return { type: 'cancel' };
  if (plain && (event.key === 'Backspace' || event.key === 'Delete')) return { type: 'unbind' };
  const kb = keybindFromEvent(event, isMac);
  return kb ? { type: 'set', keybind: serializeKeybind(kb) } : null;
}

/** Why a binding can't be used for this command, or null if it's fine. */
export function keybindProblem(
  keybind: string,
  command: Pick<Command, 'allowInInputs'>,
): string | null {
  const kb = parseKeybind(keybind);
  if (!kb) return 'That key can’t be used as a shortcut.';
  const hasModifier = kb.mod || kb.ctrl || kb.meta || kb.alt;
  const printable = kb.key.length === 1;
  // Works even while typing, so a bare letter would eat that letter in the composer.
  if (command.allowInInputs && printable && !hasModifier)
    return 'Add Ctrl, Alt or Cmd: this shortcut also works while typing, so a plain key would get in the way of writing.';
  return null;
}

/** commandId → the other command ids bound to the same keys. */
export function keybindConflicts(
  commands: readonly Command[],
  overrides: Readonly<Record<string, string>>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of findKeybindConflicts(resolveKeybinds(commands, overrides))) {
    for (const id of group)
      out.set(
        id,
        group.filter((other) => other !== id),
      );
  }
  return out;
}
