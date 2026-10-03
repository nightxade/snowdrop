/** Engine state, results and effects (shared by every engine module). */
import type { FindKind } from './motions';

export type Mode = 'normal' | 'insert' | 'visual' | 'visual-line';

export interface Register {
  text: string;
  linewise: boolean;
}

export interface Snapshot {
  text: string;
  cursor: number;
}

/** The last change, for "." — the keys that made it and any text typed in Insert mode. */
export interface Change {
  keys: readonly string[];
  insert?: string;
}

export interface InsertSession {
  /** State before the command that entered Insert mode (one undo step for both). */
  base: Snapshot;
  /** Text when Insert mode began, to work out what was typed. */
  entryText: string;
  /** Command keys for "." (null: not repeatable, e.g. entered by the host). */
  keys: readonly string[] | null;
  /** i/a/I/A with a count insert the typed text count times. */
  repeat: number;
}

export interface VimState {
  readonly text: string;
  /** UTF-16 offset of the cursor (Normal: the character under the block). */
  readonly cursor: number;
  /** Visual-mode anchor (UTF-16 offset). */
  readonly anchor: number;
  readonly mode: Mode;
  /** Keys of the command being typed ("d2", "f"). */
  readonly pending: readonly string[];
  readonly register: Register;
  readonly undo: readonly Snapshot[];
  readonly redo: readonly Snapshot[];
  readonly lastChange: Change | null;
  readonly lastFind: { kind: FindKind; char: string } | null;
  /** Column j/k aim for. */
  readonly goal: number | null;
  readonly insert: InsertSession | null;
}

export type VimEffect =
  /** Normal-mode Enter: send the message. */
  | { type: 'submit' }
  /** Normal-mode Escape with nothing pending: the host's own Escape (cancel reply, mark read…). */
  | { type: 'escape' }
  /** "+y / "*y (and deletes into those registers): copy to the system clipboard. */
  | { type: 'clipboard'; text: string }
  | { type: 'mode'; mode: Mode };

export interface FeedResult {
  state: VimState;
  effects: VimEffect[];
  /** False: let the key do its native thing (Insert-mode typing, Tab, unknown chords). */
  handled: boolean;
  /** Keys that formed no engine command; the host may try them as app bindings ("gt"). */
  rejected?: readonly string[];
}

/** The host field's contents, as `sync` adopts them. */
export interface FieldState {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}
