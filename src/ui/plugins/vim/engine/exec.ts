/**
 * One command's execution context: the state being built, a text model over
 * it, and the editing primitives every command module uses (replace, yank,
 * one-undo-step changes, entering Insert mode, motions). Command modules
 * (normal.ts, visual.ts, operators.ts, dot.ts) are functions over an Exec.
 */
import { findInLine, simpleMotion, type FindKind, type MotionResult } from './motions';
import type { MotionSpec, Parsed } from './parse';
import { startInsert } from './insert';
import { clampNormal } from './positions';
import { TextModel } from './text';
import type { FeedResult, Mode, Snapshot, VimEffect, VimState } from './types';
import { pushUndo, snapshot } from './undo';

/** Feeds one key; `replaying` is set while "." replays a change. */
export type FeedFn = (state: VimState, token: string, replaying: boolean) => FeedResult;

export class Exec {
  s: VimState;
  m: TextModel;
  readonly effects: VimEffect[] = [];
  readonly startMode: Mode;

  constructor(
    state: VimState,
    readonly cmd: Parsed,
    readonly keys: readonly string[],
    readonly replaying: boolean,
    /** For ".", which replays keys through the engine. */
    readonly feed: FeedFn,
  ) {
    this.s = state;
    this.m = new TextModel(state.text);
    this.startMode = state.mode;
  }

  /** Grapheme index of the cursor. */
  get cur(): number {
    return this.m.indexAt(this.s.cursor);
  }

  set(next: Partial<VimState>): void {
    this.s = { ...this.s, ...next };
    if (next.text !== undefined) this.m = new TextModel(this.s.text);
  }

  /** Replaces the whole state (after a sub-feed or a pure state function). */
  reset(state: VimState): void {
    this.s = state;
    this.m = new TextModel(state.text);
  }

  setCursor(i: number, keepGoal = false): void {
    this.set({ cursor: this.m.offset(i), ...(keepGoal ? {} : { goal: null }) });
  }

  /** Replaces grapheme range [from, to) with `insert`. */
  replace(from: number, to: number, insert: string): void {
    const a = this.m.offset(from);
    const b = this.m.offset(to);
    this.set({ text: this.s.text.slice(0, a) + insert + this.s.text.slice(b) });
  }

  yank(text: string, linewise: boolean, register: string | null): void {
    this.set({ register: { text, linewise } });
    if (register === '+' || register === '*') this.effects.push({ type: 'clipboard', text });
  }

  /** Only Normal-mode commands are repeatable ("." replays keys in Normal mode). */
  get repeatKeys(): readonly string[] | null {
    return this.startMode === 'normal' && !this.replaying ? this.keys : null;
  }

  /** Runs a text change as one undo step (and records it for "." when repeatable). */
  change(fn: () => void, repeatable = true): void {
    const before = snapshot(this.s);
    fn();
    if (this.s.text !== before.text) {
      this.set(pushUndo(this.s, before));
      const keys = repeatable ? this.repeatKeys : null;
      if (keys) this.set({ lastChange: { keys } });
    }
  }

  /** Enters Insert mode at grapheme `i`; `base` is the undo step's starting point. */
  insertAt(i: number, base: Snapshot, repeat = 1): void {
    this.s = startInsert(this.s, this.m.offset(i), this.repeatKeys, repeat, base);
  }

  // ── motions

  motion(
    spec: MotionSpec,
    count: number,
    countGiven: boolean,
    operator: boolean,
  ): MotionResult | null {
    const { m } = this;
    const from = this.cur;
    if (spec.key === ';' || spec.key === ',') {
      const last = this.s.lastFind;
      if (!last) return null;
      const reverse: Record<FindKind, FindKind> = { f: 'F', F: 'f', t: 'T', T: 't' };
      const kind = spec.key === ';' ? last.kind : reverse[last.kind];
      const to = findInLine(m, from, kind, last.char, count, true);
      if (to === null) return null;
      return { to, kind: kind === 'f' || kind === 't' ? 'inclusive' : 'exclusive', goal: null };
    }
    if (spec.arg !== undefined) {
      const kind = spec.key as FindKind;
      this.set({ lastFind: { kind, char: spec.arg } });
      const to = findInLine(m, from, kind, spec.arg, count);
      if (to === null) return null;
      return { to, kind: kind === 'f' || kind === 't' ? 'inclusive' : 'exclusive', goal: null };
    }
    const r = simpleMotion(m, from, spec.key, { count, countGiven, operator, goal: this.s.goal });
    return r === 'fail' || r === null ? null : r;
  }

  moveNormal(spec: MotionSpec, count: number, countGiven: boolean): void {
    const r = this.motion(spec, count, countGiven, false);
    if (!r) return;
    this.set({
      cursor: this.m.offset(clampNormal(this.m, r.to)),
      goal: r.goal === undefined ? this.s.goal : r.goal,
    });
  }
}
