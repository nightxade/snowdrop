import { describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import {
  CommandRegistry,
  formatKeyToken,
  KeybindDispatcher,
  KeyLayerStack,
  KeySequencer,
  keyToken,
  parseKeySequence,
  type KeyLayerContext,
  type LayerKeyEvent,
} from './index';

const ctx: KeyLayerContext = { target: 'none', overlay: false, surface: null };

function ev(init: Partial<LayerKeyEvent> & { key: string }): LayerKeyEvent {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init };
}

describe('keyToken', () => {
  it.each<[Partial<LayerKeyEvent> & { key: string }, string | null]>([
    [{ key: 'j', code: 'KeyJ' }, 'j'],
    [{ key: 'G', code: 'KeyG', shiftKey: true }, 'G'],
    [{ key: '$', code: 'Digit4', shiftKey: true }, '$'],
    [{ key: ' ', code: 'Space' }, ' '],
    [{ key: 'Escape' }, '<Esc>'],
    [{ key: 'Enter' }, '<CR>'],
    [{ key: 'ArrowDown' }, '<Down>'],
    [{ key: 'd', code: 'KeyD', ctrlKey: true }, '<C-d>'],
    [{ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }, '<C-S-d>'],
    [{ key: '[', code: 'BracketLeft', ctrlKey: true }, '<C-[>'],
    [{ key: 'Enter', ctrlKey: true }, '<C-CR>'],
    [{ key: 'k', code: 'KeyK', metaKey: true }, '<D-k>'],
    [{ key: 'j', code: 'KeyJ', altKey: true }, '<A-j>'],
    // Layout-aware: Dvorak's produced letter wins over the physical key…
    [{ key: 'h', code: 'KeyJ' }, 'h'],
    // …but a non-ASCII layout maps by position (Cyrillic "о" sits on J).
    [{ key: 'о', code: 'KeyJ' }, 'j'],
    [{ key: 'П', code: 'KeyG', shiftKey: true }, 'G'],
    [{ key: 'в', code: 'KeyD', ctrlKey: true }, '<C-d>'],
    // macOS Option produces symbols: the physical key decides.
    [{ key: '∆', code: 'KeyJ', altKey: true }, '<A-j>'],
    [{ key: 'Dead', code: 'BracketLeft' }, '['],
    [{ key: 'é', code: 'Unknown' }, 'é'],
    // Bare modifiers are not keys.
    [{ key: 'Shift', shiftKey: true }, null],
    [{ key: 'Control', ctrlKey: true }, null],
    [{ key: 'Meta', metaKey: true }, null],
  ])('%j → %s', (init, expected) => {
    expect(keyToken(ev(init))).toBe(expected);
  });

  it('formats tokens for help sheets', () => {
    expect(formatKeyToken('<C-d>')).toBe('Ctrl+D');
    expect(formatKeyToken('<Esc>')).toBe('Esc');
    expect(formatKeyToken('<CR>')).toBe('Enter');
    expect(formatKeyToken(' ')).toBe('Space');
    expect(formatKeyToken('g')).toBe('g');
  });

  it('parses Vim-notation sequences, substituting the leader', () => {
    expect(parseKeySequence('gg')).toEqual(['g', 'g']);
    expect(parseKeySequence('<C-d>x')).toEqual(['<C-d>', 'x']);
    expect(parseKeySequence('<leader>s')).toEqual([' ', 's']);
    expect(parseKeySequence('<leader>s', ',')).toEqual([',', 's']);
    expect(parseKeySequence('a<b')).toEqual(['a', '<', 'b']);
    expect(parseKeySequence('👍x')).toEqual(['👍', 'x']);
  });
});

describe('KeySequencer', () => {
  function setup(timeout = 1000) {
    const scheduler = new ManualScheduler();
    const runs: string[] = [];
    const pendings: string[] = [];
    const seq = new KeySequencer({
      bindings: [
        { keys: ['j'], run: (n) => runs.push(`j:${n}`) },
        { keys: ['g', 'g'], run: (n) => runs.push(`gg:${n}`) },
        { keys: ['g', 't'], run: (n) => runs.push(`gt:${n}`) },
        { keys: ['G'], run: (n) => runs.push(`G:${n}`), countable: false },
        { keys: ['0'], run: () => runs.push('zero') },
      ],
      timeoutMs: () => timeout,
      scheduler,
      onPendingChange: (p) => pendings.push(p),
    });
    return { seq, runs, scheduler, pendings };
  }

  it('runs single keys and multi-key sequences', () => {
    const { seq, runs } = setup();
    expect(seq.feed('j', ctx)).toBe('matched');
    expect(seq.feed('g', ctx)).toBe('pending');
    expect(seq.feed('g', ctx)).toBe('matched');
    expect(seq.feed('g', ctx)).toBe('pending');
    expect(seq.feed('t', ctx)).toBe('matched');
    expect(runs).toEqual(['j:null', 'gg:null', 'gt:null']);
  });

  it('parses counts (a leading 0 is a key, later zeros extend the count)', () => {
    const { seq, runs, pendings } = setup();
    for (const k of ['1', '0', 'j']) seq.feed(k, ctx);
    seq.feed('3', ctx);
    seq.feed('g', ctx);
    seq.feed('g', ctx);
    seq.feed('0', ctx);
    seq.feed('5', ctx);
    seq.feed('G', ctx);
    expect(runs).toEqual(['j:10', 'gg:3', 'zero', 'G:null']);
    expect(pendings).toContain('3g');
  });

  it('drops a partial sequence after the timeout', () => {
    const { seq, runs, scheduler } = setup(500);
    seq.feed('g', ctx);
    expect(seq.isPending).toBe(true);
    scheduler.advance(499);
    expect(seq.isPending).toBe(true);
    scheduler.advance(1);
    expect(seq.isPending).toBe(false);
    expect(seq.feed('t', ctx)).toBe('none');
    expect(runs).toEqual([]);
  });

  it('swallows a stray key after a prefix, but lets a fresh unknown key fall through', () => {
    const { seq, runs } = setup();
    seq.feed('g', ctx);
    expect(seq.feed('x', ctx)).toBe('matched');
    expect(seq.feed('x', ctx)).toBe('none');
    expect(seq.feed('j', ctx)).toBe('matched');
    expect(runs).toEqual(['j:null']);
  });

  it('reset clears the buffer and the timer', () => {
    const { seq, scheduler } = setup();
    seq.feed('4', ctx);
    seq.feed('g', ctx);
    expect(seq.pending).toBe('4g');
    seq.reset();
    expect(seq.pending).toBe('');
    expect(scheduler.pending).toBe(0);
  });
});

describe('KeyLayerStack', () => {
  it('offers keys newest-first and stops at the first layer that handles them', () => {
    const stack = new KeyLayerStack();
    const seen: string[] = [];
    stack.add({
      id: 'bottom',
      onKey: (s) => {
        seen.push(`bottom:${s.token}`);
        return true;
      },
    });
    const removeTop = stack.add({
      id: 'top',
      onKey: (s) => {
        seen.push(`top:${s.token}`);
        return s.token === 'x';
      },
    });
    expect(stack.handle(ev({ key: 'x' }), ctx)).toBe(true);
    expect(stack.handle(ev({ key: 'y' }), ctx)).toBe(true);
    expect(seen).toEqual(['top:x', 'top:y', 'bottom:y']);
    removeTop();
    seen.length = 0;
    stack.handle(ev({ key: 'x' }), ctx);
    expect(seen).toEqual(['bottom:x']);
  });

  it('passes the focus context through', () => {
    const stack = new KeyLayerStack();
    const onKey = vi.fn(() => false);
    stack.add({ id: 'a', onKey });
    const context: KeyLayerContext = { target: 'message', overlay: true, surface: null };
    stack.handle(ev({ key: 'j' }), context);
    expect(onKey).toHaveBeenCalledWith(expect.objectContaining({ token: 'j' }), context);
  });

  it('never sees IME composition or bare modifiers', () => {
    const stack = new KeyLayerStack();
    const onKey = vi.fn(() => true);
    stack.add({ id: 'a', onKey });
    expect(stack.handle(ev({ key: 'j', isComposing: true }), ctx)).toBe(false);
    expect(stack.handle(ev({ key: 'Process', keyCode: 229 }), ctx)).toBe(false);
    expect(stack.handle(ev({ key: 'Shift', shiftKey: true }), ctx)).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('isolates a throwing layer and reports it', () => {
    const onError = vi.fn();
    const stack = new KeyLayerStack(onError);
    stack.add({ id: 'ok', onKey: () => true }, 'p1');
    stack.add(
      {
        id: 'bad',
        onKey: () => {
          throw new Error('boom');
        },
      },
      'p2',
    );
    expect(stack.handle(ev({ key: 'j' }), ctx)).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ owner: 'p2' }),
    );
  });

  it('disposes layers once and notifies subscribers', () => {
    const stack = new KeyLayerStack();
    const dispose = vi.fn();
    const changed = vi.fn();
    stack.subscribe(changed);
    const remove = stack.add({ id: 'a', onKey: () => true, dispose });
    expect(stack.layers()).toHaveLength(1);
    remove();
    remove();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stack.layers()).toHaveLength(0);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('with no layers, handles nothing and the keybind dispatcher works as before', () => {
    const stack = new KeyLayerStack();
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register({ id: 'x', title: 'X', keybind: 'Mod+K', run });
    const dispatcher = new KeybindDispatcher(registry, () => ({}), false);
    const press = ev({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(stack.handle(press, ctx)).toBe(false);
    expect(dispatcher.handle(press, { inEditable: false })).toBe('x');
    expect(run).toHaveBeenCalled();
  });
});
