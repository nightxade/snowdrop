import { describe, expect, it } from 'vitest';
import type { KeyLayerContext, KeyStroke } from '@/core/commands';
import { ModeStore } from './modeStore';
import { VimController, type VimHost } from './VimController';

const stroke = (token: string): KeyStroke => ({
  token,
  event: { key: token, code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false },
});
const listCtx: KeyLayerContext = { target: 'list', overlay: false, surface: null };

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
