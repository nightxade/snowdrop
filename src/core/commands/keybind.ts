/**
 * Keybind parsing, matching and formatting.
 *
 * Bindings are stored as portable strings like "Mod+Shift+K" where `Mod` is
 * Cmd on macOS and Ctrl elsewhere, so one default works on every platform and
 * user overrides survive syncing settings between machines.
 */

export interface Keybind {
  /** Normalised key: lowercase letter/digit/symbol or a named key ("arrowup", "escape"). */
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/** The subset of KeyboardEvent we need; keeps this module DOM-free. */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  esc: 'escape',
  space: ' ',
  spacebar: ' ',
  del: 'delete',
  return: 'enter',
  comma: ',',
  slash: '/',
  period: '.',
  plus: '+',
  minus: '-',
  pgup: 'pageup',
  pgdn: 'pagedown',
};

function normaliseKey(key: string): string {
  const lower = key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

export function parseKeybind(input: string): Keybind | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Split on '+' but allow a literal '+' key at the end ("Mod++").
  const parts = trimmed.endsWith('++')
    ? [...trimmed.slice(0, -2).split('+'), '+']
    : trimmed.split('+');
  const kb: Keybind = { key: '', mod: false, ctrl: false, meta: false, alt: false, shift: false };
  for (const [i, raw] of parts.entries()) {
    const part = raw.trim().toLowerCase();
    const isLast = i === parts.length - 1;
    if (!isLast) {
      if (part === 'mod') kb.mod = true;
      else if (part === 'ctrl' || part === 'control') kb.ctrl = true;
      else if (part === 'cmd' || part === 'meta' || part === 'command' || part === 'super')
        kb.meta = true;
      else if (part === 'alt' || part === 'option' || part === 'opt') kb.alt = true;
      else if (part === 'shift') kb.shift = true;
      else return null;
    } else {
      if (!part) return null;
      kb.key = normaliseKey(raw.trim());
    }
  }
  return kb.key ? kb : null;
}

/** Resolves `Mod` into the concrete modifier for the platform. */
function concrete(kb: Keybind, isMac: boolean): Omit<Keybind, 'mod'> {
  return {
    key: kb.key,
    ctrl: kb.ctrl || (kb.mod && !isMac),
    meta: kb.meta || (kb.mod && isMac),
    alt: kb.alt,
    shift: kb.shift,
  };
}

/** Key implied by the physical key code, independent of layout-modifying keys (Alt on macOS, Shift symbols). */
function keyFromCode(code: string | undefined): string | null {
  if (!code) return null;
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Slash: '/',
    Comma: ',',
    Period: '.',
    Minus: '-',
    Equal: '=',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Backquote: '`',
    Space: ' ',
  };
  return map[code] ?? null;
}

export function matchesKeybind(event: KeyEventLike, kb: Keybind, isMac: boolean): boolean {
  const want = concrete(kb, isMac);
  if (
    event.ctrlKey !== want.ctrl ||
    event.metaKey !== want.meta ||
    event.altKey !== want.alt ||
    event.shiftKey !== want.shift
  ) {
    return false;
  }
  return normaliseKey(event.key) === want.key || keyFromCode(event.code) === want.key;
}

const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift', 'os', 'altgraph']);

/** Builds a keybind from a key press (for "record shortcut" UIs); null for bare modifiers. */
export function keybindFromEvent(event: KeyEventLike, isMac: boolean): Keybind | null {
  const key = normaliseKey(event.key);
  if (MODIFIER_KEYS.has(key)) return null;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  return {
    key: keyFromCode(event.code) ?? key,
    mod,
    ctrl: isMac ? event.ctrlKey : false,
    meta: isMac ? false : event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

const DISPLAY_KEYS: Record<string, [mac: string, other: string]> = {
  arrowup: ['↑', '↑'],
  arrowdown: ['↓', '↓'],
  arrowleft: ['←', '←'],
  arrowright: ['→', '→'],
  escape: ['Esc', 'Esc'],
  enter: ['↩', 'Enter'],
  ' ': ['Space', 'Space'],
  pagedown: ['PgDn', 'PgDn'],
  pageup: ['PgUp', 'PgUp'],
  backspace: ['⌫', 'Backspace'],
  delete: ['⌦', 'Del'],
  tab: ['⇥', 'Tab'],
};

function displayKey(key: string, isMac: boolean): string {
  const special = DISPLAY_KEYS[key];
  if (special) return isMac ? special[0] : special[1];
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Human-readable label: "⌘⇧K" on macOS, "Ctrl+Shift+K" elsewhere. */
export function formatKeybind(kb: Keybind, isMac: boolean): string {
  const c = concrete(kb, isMac);
  if (isMac) {
    return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${displayKey(c.key, true)}`;
  }
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.meta) parts.push('Win');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  parts.push(displayKey(c.key, false));
  return parts.join('+');
}

const STORAGE_NAMES: Record<string, string> = {
  ' ': 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Escape',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

/** Canonical storage form ("Mod+Shift+K"); round-trips through parseKeybind. */
export function serializeKeybind(kb: Keybind): string {
  const parts: string[] = [];
  if (kb.mod) parts.push('Mod');
  if (kb.ctrl) parts.push('Ctrl');
  if (kb.meta) parts.push('Meta');
  if (kb.alt) parts.push('Alt');
  if (kb.shift) parts.push('Shift');
  const key = kb.key;
  parts.push(
    STORAGE_NAMES[key] ??
      (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)),
  );
  return parts.join('+');
}

export function isMacPlatform(nav?: { platform?: string; userAgent?: string }): boolean {
  const n = nav ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const s = `${n?.platform ?? ''} ${n?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/u.test(s);
}
