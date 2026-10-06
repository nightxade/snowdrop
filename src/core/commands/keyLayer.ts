/**
 * Modal key layers: a stack of handlers that see a key press before the
 * keybind dispatcher and before the focused widget (the DOM listener in ui/
 * runs them in the capture phase). A layer returns true to consume the key.
 * With no layer installed nothing changes, so the default keyboard map is
 * untouched unless a plugin (Vim mode) opts in.
 *
 * Also here: key tokens (Vim-style notation, layout-aware the same way as
 * keybind matching) and a small sequencer for multi-key bindings with counts
 * and a timeout ("gg", "]u", "3j"), so layers needn't re-implement it.
 */
import {
  createLogger,
  ObservableList,
  systemScheduler,
  type Cancel,
  type Disposer,
  type Scheduler,
  type Unsubscribe,
} from '@/core/lib';
import type { KeyEventLike } from './keybind';

const log = createLogger('app');

/** Where keyboard focus is, as far as key layers care. */
export type FocusTarget =
  /** Nothing in particular (document body). */
  | 'none'
  /** The message list's scroller. */
  | 'list'
  /** A message row (the row itself, not a control inside it). */
  | 'message'
  /** A registered text surface (the composer). */
  | 'composer'
  /** Some other text field. */
  | 'input'
  /** Any other focusable control (buttons, sidebar rows…). */
  | 'other';

export interface TextSelectionState {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * A text field a layer may edit (the composer registers one). DOM-free so
 * layers stay testable; ui/ implements it over a textarea.
 */
export interface TextSurface {
  /** Stable per logical field (the composer uses its conversation id). */
  readonly id: string;
  read(): TextSelectionState;
  /** Replaces text and selection through the field's editing pipeline (keeps native undo). */
  write(next: TextSelectionState): void;
  /** Sends / submits, like the field's own Enter. */
  submit(): void;
  /**
   * Runs the field's own Escape behaviour (cancel reply → mark read when
   * empty) and reports what it did.
   */
  escape(): 'reply' | 'read' | 'none';
  /** Suggestions (@, :, /) only make sense while inserting text. */
  setSuggestionsEnabled(enabled: boolean): void;
}

export interface KeyLayerContext {
  target: FocusTarget;
  /** A dialog, menu or listbox is open: it owns the keyboard. */
  overlay: boolean;
  /** Set when target is 'composer'. */
  surface: TextSurface | null;
}

/** A key press as layers see it: a normalised token plus the raw event. */
export interface KeyStroke {
  token: string;
  event: KeyEventLike;
}

export interface KeyHelpItem {
  /** Display keys; "|" separates alternatives ("j|↓"). */
  keys: string;
  title: string;
}

export interface KeyHelpGroup {
  title: string;
  items: readonly KeyHelpItem[];
}

export interface KeyLayer {
  id: string;
  /** Return true to consume the key (the caller prevents default and stops propagation). */
  onKey(stroke: KeyStroke, ctx: KeyLayerContext): boolean;
  /** Help shown in the keyboard shortcut sheet while the layer is installed. */
  help?: readonly KeyHelpGroup[];
  /** Called when the layer is removed (cancel timers). */
  dispose?(): void;
}

export interface RegisteredKeyLayer {
  layer: KeyLayer;
  /** Plugin id (or "core") that installed it. */
  owner: string;
}

/** The raw key event fields the stack needs beyond KeyEventLike. */
export interface LayerKeyEvent extends KeyEventLike {
  isComposing?: boolean;
  keyCode?: number;
}

export class KeyLayerStack {
  private readonly list = new ObservableList<RegisteredKeyLayer>();

  constructor(
    private readonly onError: (error: unknown, layer: RegisteredKeyLayer) => void = (e, l) => {
      log.error(`key layer "${l.layer.id}" (${l.owner}) failed`, e);
    },
  ) {}

  /** Installs a layer on top of the stack (newest gets first refusal). */
  add(layer: KeyLayer, owner = 'core'): Disposer {
    const entry: RegisteredKeyLayer = { layer, owner };
    const remove = this.list.add(entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      remove();
      try {
        layer.dispose?.();
      } catch (error) {
        this.onError(error, entry);
      }
    };
  }

  layers(): readonly RegisteredKeyLayer[] {
    return this.list.list();
  }

  subscribe(fn: () => void): Unsubscribe {
    return this.list.subscribe(fn);
  }

  /**
   * Offers a key to the layers, newest first. IME composition and bare
   * modifier presses never reach them. A layer that throws is skipped.
   */
  handle(event: LayerKeyEvent, ctx: KeyLayerContext): boolean {
    const layers = this.list.list();
    if (layers.length === 0) return false;
    if (event.isComposing || event.keyCode === 229) return false;
    const token = keyToken(event);
    if (token === null) return false;
    const stroke: KeyStroke = { token, event };
    for (let i = layers.length - 1; i >= 0; i--) {
      const entry = layers[i] as RegisteredKeyLayer;
      try {
        if (entry.layer.onKey(stroke, ctx)) return true;
      } catch (error) {
        this.onError(error, entry);
      }
    }
    return false;
  }
}

// ─── Key tokens ─────────────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  Escape: '<Esc>',
  Esc: '<Esc>',
  Enter: '<CR>',
  Backspace: '<BS>',
  Tab: '<Tab>',
  Delete: '<Del>',
  ArrowUp: '<Up>',
  ArrowDown: '<Down>',
  ArrowLeft: '<Left>',
  ArrowRight: '<Right>',
  Home: '<Home>',
  End: '<End>',
  PageUp: '<PageUp>',
  PageDown: '<PageDown>',
  Insert: '<Insert>',
};

const MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'OS', 'AltGraph', 'CapsLock', 'Fn']);

const CODE_SYMBOLS: Record<string, [plain: string, shifted: string]> = {
  Slash: ['/', '?'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Backquote: ['`', '~'],
  Space: [' ', ' '],
};

function isPrintableAscii(key: string): boolean {
  return key.length === 1 && key >= ' ' && key <= '~';
}

/** US-layout character for a physical key, for layouts that produce no ASCII (Cyrillic, Greek…). */
function charFromCode(code: string | undefined, shift: boolean): string | null {
  if (!code) return null;
  if (code.startsWith('Key') && code.length === 4) {
    const c = code.slice(3).toLowerCase();
    return shift ? c.toUpperCase() : c;
  }
  if (code.startsWith('Digit') && code.length === 6 && !shift) return code.slice(5);
  const sym = CODE_SYMBOLS[code];
  return sym ? sym[shift ? 1 : 0] : null;
}

/**
 * Vim-style token for a key press, or null for bare modifiers:
 * printable keys are the produced character ("j", "G", "$", " "), named
 * keys are bracketed ("<Esc>", "<CR>"), and Ctrl/Alt/Meta chords are
 * "<C-d>", "<A-j>", "<D-k>" (Shift appears as "S-" only inside chords).
 *
 * Same convention as keybind matching: the produced character wins when it
 * is printable ASCII (Dvorak users get their own letters); otherwise the
 * physical key decides (a Cyrillic layout's "о" on the J key is "j").
 */
export function keyToken(event: KeyEventLike): string | null {
  if (MODIFIERS.has(event.key)) return null;
  const named = NAMED[event.key];
  let base: string | null;
  if (named) base = named;
  else if (isPrintableAscii(event.key)) base = event.key;
  // Non-ASCII (and dead/unidentified) keys map by physical position, else stay as typed.
  else
    base = charFromCode(event.code, event.shiftKey) ?? (/^.$/su.test(event.key) ? event.key : null);
  if (base === null) return null;
  const chord = event.ctrlKey || event.altKey || event.metaKey;
  if (!chord) return base;
  const inner = named ? named.slice(1, -1) : base.length === 1 ? base.toLowerCase() : base;
  const shifted = event.shiftKey && (named !== undefined || /[a-z]/iu.test(base));
  const prefix = `${event.ctrlKey ? 'C-' : ''}${event.altKey ? 'A-' : ''}${event.metaKey ? 'D-' : ''}${shifted ? 'S-' : ''}`;
  return `<${prefix}${inner}>`;
}

/** Display form for help sheets: "<C-d>" → "Ctrl+D", "<Esc>" → "Esc", " " → "Space". */
export function formatKeyToken(token: string): string {
  if (token === ' ') return 'Space';
  const m = /^<(.+)>$/u.exec(token);
  if (!m) return token;
  const parts = (m[1] as string).split('-');
  const key = parts.pop() ?? '';
  const mods = parts.map((p) => ({ C: 'Ctrl', A: 'Alt', D: 'Cmd', S: 'Shift' })[p] ?? p);
  const names: Record<string, string> = { CR: 'Enter', BS: 'Backspace', Del: 'Del' };
  const shown = names[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods, shown].join('+');
}

/**
 * Splits a binding written in Vim notation into tokens: "gg" → ["g","g"],
 * "<C-d>" → ["<C-d>"], "<leader>s" → [leader, "s"].
 */
export function parseKeySequence(input: string, leader = ' '): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '<') {
      const close = input.indexOf('>', i + 1);
      if (close > i + 1) {
        const name = input.slice(i, close + 1);
        out.push(name.toLowerCase() === '<leader>' ? leader : name === '<Space>' ? ' ' : name);
        i = close + 1;
        continue;
      }
    }
    const ch = String.fromCodePoint(input.codePointAt(i) ?? 0);
    out.push(ch);
    i += ch.length;
  }
  return out;
}

// ─── Sequencer ──────────────────────────────────────────────────────────

export interface SequenceBinding<C = KeyLayerContext> {
  /** Tokens, e.g. ["g", "g"]. */
  keys: readonly string[];
  /** count is null when none was typed. */
  run(count: number | null, ctx: C): void;
  /** Accepts a count prefix ("3j"); default true. */
  countable?: boolean;
}

export type SequenceResult = 'matched' | 'pending' | 'none';

export interface KeySequencerOptions<C> {
  bindings: readonly SequenceBinding<C>[];
  /** Read on every key, so a settings change applies immediately. */
  timeoutMs: () => number;
  scheduler?: Scheduler;
  /** Notified whenever the pending buffer changes (e.g. to show "3g"). */
  onPendingChange?: (pending: string) => void;
}

/**
 * Turns tokens into binding runs: optional count (1-9 then digits), then a
 * key sequence matched by prefix. A partial sequence waits up to the timeout
 * for the next key, then is dropped (like Vim's 'timeoutlen'). An unknown
 * key clears the buffer and reports 'none' so it can fall through.
 */
export class KeySequencer<C = KeyLayerContext> {
  private count = '';
  private keys: string[] = [];
  private cancel: Cancel | null = null;
  private readonly scheduler: Scheduler;

  constructor(private readonly options: KeySequencerOptions<C>) {
    this.scheduler = options.scheduler ?? systemScheduler;
  }

  get pending(): string {
    return this.count + this.keys.join('');
  }

  get isPending(): boolean {
    return this.count !== '' || this.keys.length > 0;
  }

  reset(): void {
    const had = this.isPending;
    this.count = '';
    this.keys = [];
    this.cancel?.();
    this.cancel = null;
    if (had) this.options.onPendingChange?.('');
  }

  feed(token: string, ctx: C): SequenceResult {
    this.cancel?.();
    this.cancel = null;
    if (this.keys.length === 0 && /^[0-9]$/u.test(token) && (token !== '0' || this.count !== '')) {
      // A leading "0" is a key (go to start); later zeros extend the count.
      this.count += token;
      this.arm();
      return 'pending';
    }
    const keys = [...this.keys, token];
    const exact = this.options.bindings.find((b) => sameKeys(b.keys, keys));
    const longer = this.options.bindings.some(
      (b) => b.keys.length > keys.length && startsWith(b.keys, keys),
    );
    if (exact && !longer) {
      const count = this.count === '' ? null : Math.min(9999, Number(this.count));
      this.reset();
      exact.run(exact.countable === false ? null : count, ctx);
      return 'matched';
    }
    if (longer) {
      this.keys = keys;
      this.arm();
      return 'pending';
    }
    const hadPending = this.isPending;
    this.reset();
    // A stray key after a prefix ("gx") is swallowed, like Vim; a fresh one falls through.
    return hadPending ? 'matched' : 'none';
  }

  private arm(): void {
    this.options.onPendingChange?.(this.pending);
    const ms = this.options.timeoutMs();
    if (ms > 0)
      this.cancel = this.scheduler.setTimeout(() => {
        this.cancel = null;
        this.reset();
      }, ms);
  }
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

function startsWith(a: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((k, i) => a[i] === k);
}
