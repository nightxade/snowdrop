/**
 * The Vim mode key layer: app navigation when focus isn't in a text field,
 * and modal editing in the composer (via the pure engine). Holds one engine
 * state per composer (keyed by conversation) so mode, undo and registers
 * survive switching conversations.
 */
import {
  KeySequencer,
  NavCommand,
  parseKeySequence,
  type KeyLayer,
  type KeyLayerContext,
  type KeyStroke,
  type TextSurface,
} from '@/core/commands';
import type { Scheduler } from '@/core/lib';
import {
  createVimState,
  enterInsert,
  feed,
  selectionFor,
  sync,
  type FeedResult,
  type Mode,
  type VimState,
} from './engine/engine';
import { NAV_BINDINGS, vimHelp, type NavBinding, type VimActions } from './keymap';
import type { ModeStore } from './modeStore';

export interface VimOptions {
  navigation: boolean;
  composer: boolean;
  startInInsert: boolean;
  leader: string;
  timeoutMs: number;
}

export interface VimHost {
  options(): VimOptions;
  /** Runs a command by id (the plugin's ctx.commands.execute). */
  execute(commandId: string): Promise<boolean>;
  /** Clipboard writes for "+y. */
  copy(text: string): void;
  toast(message: string): void;
  /** Blurs the active element (document focus moves to the body). */
  blur(): void;
  notificationsEnabled(): boolean;
  /** Id of the open conversation (the composer surface to put into Insert mode). */
  currentConversation(): string | null;
  scheduler?: Scheduler;
}

/** Printable keys with no Ctrl/Alt/Meta: in Normal mode they're commands, never text. */
function isPlainPrintable(stroke: KeyStroke): boolean {
  const e = stroke.event;
  return !e.ctrlKey && !e.altKey && !e.metaKey && /^.$/su.test(stroke.token);
}

export class VimController {
  readonly modes: ModeStore;
  private readonly states = new Map<string, VimState>();
  private readonly surfaces = new Map<string, TextSurface>();
  private nav: KeySequencer;
  private composerNav: KeySequencer;
  /** i/a/I/A/gi from a non-text control (sidebar rows, rail tiles, header buttons). */
  private otherNav: KeySequencer;
  private leader: string;
  /** The layer to install with ctx.keys.addLayer. */
  readonly layer: KeyLayer;
  /** Where the next composer focus should land in Insert mode (i/a/I/A, reply). */
  private pendingInsert: 'cursor' | 'after' | 'start' | 'end' | null = null;
  private readonly actions: VimActions;
  /** App commands run one after another ("5J" must not race five conversation switches). */
  private queue: Promise<unknown> = Promise.resolve();
  private running = 0;

  constructor(
    private readonly host: VimHost,
    modes: ModeStore,
  ) {
    this.modes = modes;
    this.actions = {
      run: (id, count) => {
        const times = Math.max(1, count ?? 1);
        // A single run starts at once, like a keybind, unless a counted run is still going.
        if (times === 1 && this.running === 0) {
          void host.execute(id);
          return;
        }
        const task = async () => {
          this.running++;
          try {
            for (let i = 0; i < times; i++) {
              // A command that's missing, disabled or failed ends the repeat.
              if (!(await host.execute(id))) break;
            }
          } finally {
            this.running--;
          }
        };
        // Counted runs go one after another, each awaiting the previous command.
        this.queue = this.running === 0 ? task() : this.queue.then(task);
      },
      insert: (where) => {
        this.pendingInsert = where;
        void host.execute(NavCommand.FocusComposer).finally(() => {
          this.pendingInsert = null;
        });
      },
      runIntoInsert: (id) => {
        this.pendingInsert = 'cursor';
        void host.execute(id).finally(() => {
          this.pendingInsert = null;
        });
      },
      toggleNotifications: () => {
        void host.execute('core.toggleNotifications').then((ok) => {
          if (ok)
            host.toast(
              host.notificationsEnabled()
                ? 'Desktop notifications on'
                : 'Desktop notifications off',
            );
        });
      },
    };
    this.leader = host.options().leader;
    this.nav = this.sequencer(() => true);
    this.composerNav = this.sequencer((b) => b.inComposer === true);
    this.otherNav = this.sequencer((b) => b.anywhere === true);
    this.layer = {
      id: 'vim',
      // A getter: the sheet's help follows the leader setting.
      get help() {
        return vimHelp(host.options().leader);
      },
      onKey: (stroke, ctx) => this.onKey(stroke, ctx),
      dispose: () => {
        this.dispose();
      },
    };
  }

  private sequencer(filter: (b: NavBinding) => boolean): KeySequencer {
    const leader = this.leader;
    return new KeySequencer({
      bindings: NAV_BINDINGS.filter(filter).map((b) => ({
        keys: parseKeySequence(b.keys, leader),
        run: (count: number | null) => {
          b.run(this.actions, count);
        },
      })),
      timeoutMs: () => this.host.options().timeoutMs,
      ...(this.host.scheduler ? { scheduler: this.host.scheduler } : {}),
      onPendingChange: (pending) => {
        this.modes.setNavPending(pending);
      },
    });
  }

  /** Rebuilds the sequencers when the leader setting changes. */
  private rebuild(): void {
    const leader = this.host.options().leader;
    if (leader === this.leader) return;
    this.leader = leader;
    this.nav.reset();
    this.composerNav.reset();
    this.otherNav.reset();
    this.nav = this.sequencer(() => true);
    this.composerNav = this.sequencer((b) => b.inComposer === true);
    this.otherNav = this.sequencer((b) => b.anywhere === true);
  }

  onKey(stroke: KeyStroke, ctx: KeyLayerContext): boolean {
    this.rebuild();
    const options = this.host.options();
    if (ctx.overlay) {
      // Dialogs, menus and the composer's suggestions own the keyboard.
      this.nav.reset();
      this.composerNav.reset();
      this.otherNav.reset();
      return false;
    }
    if (ctx.target === 'composer' && ctx.surface) {
      return options.composer ? this.onComposerKey(stroke, ctx.surface, ctx) : false;
    }
    if (
      options.navigation &&
      (ctx.target === 'none' || ctx.target === 'list' || ctx.target === 'message')
    )
      return this.onNavKey(stroke, ctx);
    // Any other focusable control (sidebar rows, rail tiles, header buttons):
    // only the "focus the composer" keys apply, and only when they match —
    // native activation (Space, Enter) must keep working on buttons.
    if (options.navigation && ctx.target === 'other') return this.onOtherKey(stroke, ctx);
    // A non-composer text field (sidebar search, a rename box…): Esc is
    // theirs first, same as any other key in an input.
    if (options.navigation && ctx.target === 'input') return this.onInputKey(stroke, ctx);
    return false;
  }

  private onOtherKey(stroke: KeyStroke, ctx: KeyLayerContext): boolean {
    if (stroke.token === '<Esc>') {
      if (this.otherNav.isPending) {
        this.otherNav.reset();
        return true;
      }
      // Nothing pending to cancel: back to Normal mode on the message list.
      return this.focusMessages();
    }
    return this.otherNav.feed(stroke.token, ctx) !== 'none';
  }

  /**
   * Esc in a non-composer text field. The field's own Escape runs first when
   * it would still do something visible — SearchInput, the one field in the
   * app that gives Escape a meaning, clears a non-empty value and nothing
   * else; `ctx.inputHasValue` mirrors exactly that check (see textSurfaces.ts)
   * so Vim mode needn't know about SearchInput, or any other field, itself.
   * Once there's nothing left to clear, Esc reaches the message list, as from any other control.
   */
  private onInputKey(stroke: KeyStroke, ctx: KeyLayerContext): boolean {
    if (stroke.token !== '<Esc>' || ctx.inputHasValue) return false;
    return this.focusMessages();
  }

  /**
   * Esc with nothing left to cancel: focus the message list's current row.
   * With no conversation open, FocusMessages is disabled (nothing to focus),
   * so blur to the document body instead — j/k have nowhere to land, but
   * J/K and space-switching still want a key layer, not a stray button.
   */
  private focusMessages(): boolean {
    void this.host.execute(NavCommand.FocusMessages).then((ok) => {
      if (!ok) this.host.blur();
    });
    return true;
  }

  private onNavKey(stroke: KeyStroke, ctx: KeyLayerContext): boolean {
    if (stroke.token === '<Esc>') {
      if (!this.nav.isPending) return false;
      this.nav.reset();
      return true;
    }
    if (this.nav.feed(stroke.token, ctx) !== 'none') return true;
    // Unmapped letters do nothing (they'd otherwise jump into the composer and type).
    // Space stays native unless it's the leader (handled above).
    return isPlainPrintable(stroke) && stroke.token !== ' ';
  }

  // ─── Composer ─────────────────────────────────────────────────────────

  private stateFor(surface: TextSurface): VimState {
    this.surfaces.set(surface.id, surface);
    const field = surface.read();
    const existing = this.states.get(surface.id);
    if (existing) return sync(existing, field);
    const mode: Mode = this.host.options().startInInsert ? 'insert' : 'normal';
    return createVimState(field.text, field.selectionEnd, mode);
  }

  private onComposerKey(stroke: KeyStroke, surface: TextSurface, ctx: KeyLayerContext): boolean {
    const before = this.stateFor(surface);
    if (before.mode === 'normal' && this.composerNav.isPending) {
      // An app sequence in progress ("]", the leader) takes this key.
      if (stroke.token === '<Esc>') this.composerNav.reset();
      else this.composerNav.feed(stroke.token, ctx);
      this.commit(surface, before, before, false);
      return true;
    }
    const result = feed(before, stroke.token);
    this.commit(surface, before, result.state, result.handled);
    this.runEffects(surface, result);
    if (!result.rejected || before.mode !== 'normal') return result.handled;
    // Keys the engine doesn't use may be app bindings (gt, ]u, :, the leader, Ctrl+D…).
    let taken = false;
    if (this.host.options().navigation)
      for (const token of result.rejected)
        if (this.composerNav.feed(token, ctx) !== 'none') taken = true;
    return result.handled || taken;
  }

  /** Saves the state and mirrors it into the field and the mode pill. */
  private commit(surface: TextSurface, before: VimState, next: VimState, write: boolean): void {
    this.states.set(surface.id, next);
    if (write && next.mode !== 'insert') {
      const sel = selectionFor(next);
      const field = surface.read();
      if (
        field.text !== next.text ||
        field.selectionStart !== sel.start ||
        field.selectionEnd !== sel.end
      )
        surface.write({ text: next.text, selectionStart: sel.start, selectionEnd: sel.end });
    } else if (write && before.mode !== 'insert') {
      // Entered Insert mode (i, a, o, cw…): text may have changed, caret collapses.
      surface.write({ text: next.text, selectionStart: next.cursor, selectionEnd: next.cursor });
    }
    surface.setSuggestionsEnabled(next.mode === 'insert');
    this.modes.set(surface.id, next.mode, next.pending.join(''), next.cursor);
  }

  private runEffects(surface: TextSurface, result: FeedResult): void {
    for (const effect of result.effects) {
      if (effect.type === 'submit') surface.submit();
      else if (effect.type === 'clipboard') this.host.copy(effect.text);
      else if (effect.type === 'escape') {
        // Normal-mode Esc: the composer's own Escape (cancel reply → mark read);
        // on an empty draft, focus goes back to the newest message, never
        // wherever the roving tab stop was last left.
        if (surface.escape() === 'read') void this.host.execute(NavCommand.FocusLatestMessage);
      }
    }
  }

  /** The composer gained focus: show the mode (block cursor, suggestions) before any key. */
  onSurfaceFocus(surface: TextSurface): void {
    if (!this.host.options().composer) return;
    let state = this.stateFor(surface);
    const where = this.pendingInsert;
    this.pendingInsert = null;
    if (where) state = enterInsert(state, where);
    this.commit(surface, state, state, true);
    if (where && state.mode === 'insert') {
      surface.write({ text: state.text, selectionStart: state.cursor, selectionEnd: state.cursor });
    }
  }

  /**
   * IME composition is about to start in the composer (compositionstart, or
   * the keyCode-229 keydown before it). Outside Insert mode the composition
   * would replace the block cursor's character and bypass the engine's undo,
   * so collapse the caret and enter Insert mode first: the composed text then
   * lands as an ordinary Insert change (one undo step, repeatable with ".").
   */
  onCompositionStart(surface: TextSurface): void {
    if (!this.host.options().composer) return;
    const state = this.stateFor(surface);
    if (state.mode === 'insert') return;
    this.composerNav.reset();
    this.commit(surface, state, enterInsert(state, 'cursor', ['i']), true);
  }

  /** For tests: resolves once queued app commands (counted runs) have finished. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** A click or drag in the composer: show the block cursor there, or Visual mode for a selection. */
  onSurfacePointer(surface: TextSurface): void {
    if (!this.host.options().composer) return;
    const state = this.stateFor(surface);
    if (state.mode !== 'insert') this.commit(surface, state, state, true);
  }

  /** Composer modal editing switched off (or the plugin stopped): leave every field native. */
  releaseComposers(): void {
    for (const [id, surface] of this.surfaces) {
      const state = this.states.get(id);
      surface.setSuggestionsEnabled(true);
      if (state && state.mode !== 'insert') {
        try {
          const field = surface.read();
          surface.write({
            text: field.text,
            selectionStart: field.selectionStart,
            selectionEnd: field.selectionStart,
          });
        } catch {
          // The field may be gone (conversation closed).
        }
      }
    }
    this.states.clear();
    this.surfaces.clear();
    this.modes.clear();
  }

  /** For tests and the host: the engine mode of a composer. */
  modeOf(id: string): Mode | null {
    return this.states.get(id)?.mode ?? null;
  }

  dispose(): void {
    this.nav.reset();
    this.composerNav.reset();
    this.otherNav.reset();
    this.releaseComposers();
  }
}
