import { describe, expect, it } from 'vitest';
import type { KeyLayerContext, KeyStroke } from '@/core/commands';
import { ModeStore } from './modeStore';
import { VimController, type VimHost } from './VimController';

const stroke = (token: string): KeyStroke => ({
  token,
  event: { key: token, code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false },
});
const listCtx: KeyLayerContext = { target: 'list', overlay: false, surface: null };
const otherCtx: KeyLayerContext = { target: 'other', overlay: false, surface: null };
const otherOverlayCtx: KeyLayerContext = { target: 'other', overlay: true, surface: null };
const inputCtx: KeyLayerContext = { target: 'input', overlay: false, surface: null };

function controller() {
  const log: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const host: VimHost = {
    options: () => ({
      navigation: true,
      composer: true,
      startInInsert: true,
      leader: ' ',
      timeoutMs: 1000,
    }),
    // An async command, like a conversation switch that awaits history.
    execute: async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 1));
      log.push(`end ${id}`);
      inFlight--;
      return true;
    },
    copy: () => undefined,
    toast: () => undefined,
    notificationsEnabled: () => true,
    currentConversation: () => null,
  };
  const vim = new VimController(host, new ModeStore());
  return { vim, log, maxInFlight: () => maxInFlight };
}

describe('VimController counted app commands', () => {
  it('awaits each run of "5J" before the next', async () => {
    const { vim, log, maxInFlight } = controller();
    for (const t of ['5', 'J']) vim.onKey(stroke(t), listCtx);
    await vim.idle();
    expect(log.filter((l) => l.startsWith('start'))).toHaveLength(5);
    expect(maxInFlight()).toBe(1);
    expect(log.slice(0, 4)).toEqual([
      'start core.nextConversation',
      'end core.nextConversation',
      'start core.nextConversation',
      'end core.nextConversation',
    ]);
  });

  it('queues a key pressed while a counted run is still going', async () => {
    const { vim, log, maxInFlight } = controller();
    for (const t of ['3', 'J', 'K']) vim.onKey(stroke(t), listCtx);
    await vim.idle();
    expect(maxInFlight()).toBe(1);
    expect(log.at(-1)).toBe('end core.prevConversation');
  });
});

describe('VimController: focus-composer keys from a non-text control', () => {
  it.each(['i', 'a', 'I', 'A', 'g'])(
    'consumes "%s" (gi for g) on target "other" and focuses the composer',
    (key) => {
      const { vim, log } = controller();
      const consumed =
        key === 'g'
          ? [vim.onKey(stroke('g'), otherCtx), vim.onKey(stroke('i'), otherCtx)].every(Boolean)
          : vim.onKey(stroke(key), otherCtx);
      expect(consumed).toBe(true);
      expect(log.some((l) => l === 'start core.focusComposer')).toBe(true);
    },
  );

  it('leaves navigation letters alone on target "other" (no j/k from a button)', () => {
    const { vim, log } = controller();
    expect(vim.onKey(stroke('j'), otherCtx)).toBe(false);
    expect(vim.onKey(stroke('m'), otherCtx)).toBe(false);
    expect(log).toHaveLength(0);
  });

  it('never consumes Space or Enter on target "other" (button activation)', () => {
    const { vim } = controller();
    expect(vim.onKey(stroke(' '), otherCtx)).toBe(false);
    expect(vim.onKey(stroke('<CR>'), otherCtx)).toBe(false);
  });

  it('is inert on target "other" while an overlay owns the keyboard', () => {
    const { vim, log } = controller();
    expect(vim.onKey(stroke('i'), otherOverlayCtx)).toBe(false);
    expect(log).toHaveLength(0);
  });

  it('is inert in a plain text input (target "input")', () => {
    const { vim, log } = controller();
    expect(vim.onKey(stroke('i'), inputCtx)).toBe(false);
    expect(log).toHaveLength(0);
  });

  it('clears a pending "g" on target "other" with Esc', () => {
    const { vim, log } = controller();
    expect(vim.onKey(stroke('g'), otherCtx)).toBe(true); // pending: "gi" is the only anywhere binding starting with g
    expect(vim.onKey({ token: '<Esc>', event: stroke('g').event }, otherCtx)).toBe(true);
    expect(vim.onKey(stroke('i'), otherCtx)).toBe(true); // fresh press, not "gi"
    expect(log.filter((l) => l === 'start core.focusComposer')).toHaveLength(1);
  });
});
