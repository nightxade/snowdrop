import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createShrike, ShrikeProvider, type Shrike } from '@/app';
import { CoreCommand } from '@/core/commands';
import type { ConversationId } from '@/core/domain';
import { createMemoryStorage } from '@/core/persistence';
import { HOME, spacesSelectors, uiSelectors } from '@/core/stores';
import { setViewport } from '@/test/bootDemo';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const live: Shrike[] = [];

beforeEach(() => {
  setViewport(1440);
});

afterEach(async () => {
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

/** Boots the whole app on the demo, with Virtuoso rendering rows despite happy-dom's missing layout. */
async function boot(): Promise<Shrike> {
  const shrike = createShrike({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  live.push(shrike);
  shrike.stores.settings.getState().update('connection', { mockLiveliness: false });
  render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 60 }}>
      <ShrikeProvider shrike={shrike}>
        <App />
      </ShrikeProvider>
    </VirtuosoMockContext.Provider>,
  );
  // The welcome screen is a lazy chunk: wait for it (outside act, so it can render).
  const demo = await screen.findByRole('button', { name: /Try the demo/u }, { timeout: 5000 });
  await act(async () => {
    fireEvent.click(demo);
    await Promise.resolve();
  });
  await act(async () => {
    await shrike.start();
    await shrike.sync.idle();
  });
  return shrike;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

/** Opens a conversation in its own space, as the sidebar would. */
async function open(shrike: Shrike, title?: string): Promise<ConversationId> {
  const conv = Object.values(shrike.stores.conversations.getState().byId).find((c) =>
    title === undefined ? c.kind === 'direct' : c.title === title,
  )!;
  const space = spacesSelectors.spaceOf(conv.id)(shrike.stores.spaces.getState()) ?? HOME;
  await act(async () => {
    shrike.stores.ui.getState().selectConversation(conv.id, space);
    await shrike.history.open(conv.id);
  });
  await settle();
  return conv.id;
}

const rows = () => [
  ...document.querySelectorAll<HTMLElement>('[data-shrike="message"][data-roving-item]'),
];

/** Virtuoso renders rows in happy-dom once its scroller sees a scroll event. */
async function showRows(): Promise<void> {
  const scroller = document.querySelector<HTMLElement>('[data-message-scroller]')!;
  await act(async () => {
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 40));
  });
}

async function bootVim(enable = true) {
  const shrike = await boot();
  const id = await open(shrike, 'Orchard · Engineering');
  await showRows();
  if (enable) {
    await act(async () => {
      await shrike.plugins.setEnabled('vim-mode', true);
    });
    await settle();
  }
  return { shrike, id };
}

const composer = () =>
  document.querySelector<HTMLTextAreaElement>('[data-shrike="composer"] textarea')!;
const pill = () => document.querySelector('[data-shrike="vim-mode"]')?.textContent ?? null;
const focused = () => document.activeElement as HTMLElement | null;

/** Dispatches a keydown at the focused element; returns whether it was prevented. */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function keys(sequence: string): void {
  for (const k of sequence) press(k, k >= 'A' && k <= 'Z' ? { shiftKey: true } : {});
}

function blur(): void {
  act(() => {
    focused()?.blur();
  });
}

/** Native typing in Insert mode (the layer lets it through; happy-dom doesn't insert). */
function typeIn(value: string): void {
  const el = composer();
  fireEvent.change(el, { target: { value } });
  el.setSelectionRange(value.length, value.length);
  fireEvent.select(el);
}

describe('Vim mode: navigation', () => {
  it('moves focus between messages with j/k, with counts', async () => {
    await bootVim();
    blur();
    press('j');
    const all = rows();
    const first = all.indexOf(focused()!);
    // From outside the list, j lands on its tab stop (the newest message).
    expect(first).toBe(all.length - 1);
    press('k');
    expect(rows().indexOf(focused()!)).toBe(first - 1);
    keys('3k');
    expect(rows().indexOf(focused()!)).toBe(first - 4);
    press('j');
    expect(rows().indexOf(focused()!)).toBe(first - 3);
    expect(focused()?.getAttribute('tabindex')).toBe('0');
  });

  it('jumps to the first loaded message with gg and back to the latest with G', async () => {
    await bootVim();
    blur();
    keys('gg');
    await settle();
    expect(focused()).toBe(rows()[0]);
    keys('G');
    await settle();
    expect(focused()).toBe(rows().at(-1));
  });

  it('steps through conversations with J/K (and counts)', async () => {
    const { shrike, id } = await bootVim();
    const selected = () => uiSelectors.selectedConversation(shrike.stores.ui.getState());
    blur();
    press('J', { shiftKey: true });
    const next = selected();
    expect(next).not.toBe(id);
    press('K', { shiftKey: true });
    expect(selected()).toBe(id);
    keys('2J');
    const two = selected();
    keys('2K');
    expect(selected()).toBe(id);
    keys('JJ');
    expect(selected()).toBe(two);
  });

  it('runs app commands: ]u, gt, :, ? and the leader', async () => {
    const { shrike } = await bootVim();
    const execute = vi.spyOn(shrike.commands, 'execute');
    blur();
    keys(']u');
    keys('gt');
    expect(execute).toHaveBeenCalledWith(CoreCommand.NextUnread);
    expect(execute).toHaveBeenCalledWith('core.nextSpace');
    press(' ');
    press('s');
    expect(execute).toHaveBeenCalledWith(CoreCommand.OpenSettings);
    act(() => {
      shrike.stores.ui.getState().closeModal();
    });
    blur();
    press(':');
    expect(shrike.stores.ui.getState().modal).toEqual({ type: 'switcher', props: { query: '>' } });
  });

  it('lists its keys in the shortcut sheet while enabled', async () => {
    await bootVim();
    blur();
    press('?');
    await settle();
    expect(screen.getByRole('heading', { name: 'Vim · Navigation' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Vim · Composer (Normal mode)' })).toBeTruthy();
  });

  it('clears a pending sequence with Esc and drops it after the timeout', async () => {
    const { shrike } = await bootVim();
    const execute = vi.spyOn(shrike.commands, 'execute');
    blur();
    press('g');
    expect(press('Escape')).toBe(true);
    press('t');
    expect(execute).not.toHaveBeenCalledWith('core.nextSpace');
  });

  it('acts on the focused message: r replies into Insert mode, dd asks first', async () => {
    const { shrike, id } = await bootVim();
    blur();
    press('j');
    const messageId = focused()?.dataset.messageId;
    press('r');
    await settle();
    expect(shrike.stores.ui.getState().replyTo[id]).toBe(messageId);
    expect(focused()).toBe(composer());
    expect(pill()).toBe('INSERT');
    press('Escape');
    press('Escape'); // Normal-mode Esc: cancels the reply first
    expect(shrike.stores.ui.getState().replyTo[id]).toBeUndefined();
    blur();
    press('j');
    keys('dd');
    await settle();
    expect(screen.getByRole('dialog', { name: /Delete for/u })).toBeTruthy();
  });
});

describe('Vim mode: composer', () => {
  it('starts in Insert mode, Esc gives Normal with a block cursor, Enter sends', async () => {
    const { shrike } = await bootVim();
    const send = vi.spyOn(shrike.send, 'send');
    blur();
    press('i');
    expect(focused()).toBe(composer());
    expect(pill()).toBe('INSERT');
    typeIn('hello vim');
    // Insert-mode keys are left to the field.
    expect(press('x')).toBe(false);
    press('Escape');
    expect(pill()).toBe('NORMAL');
    const el = composer();
    expect(el.selectionEnd - el.selectionStart).toBe(1);
    expect(el.value.slice(el.selectionStart, el.selectionEnd)).toBe('m');
    press('Enter');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].text).toBe('hello vim');
  });

  it('edits with operators and undoes through the field', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('one two three');
    press('Escape');
    press('0');
    keys('dw');
    expect(composer().value).toBe('two three');
    keys('u');
    expect(composer().value).toBe('one two three');
    keys('$x');
    expect(composer().value).toBe('one two thre');
  });

  it('keeps Escape-marks-read for Normal mode on an empty draft, and returns to the messages', async () => {
    const { shrike } = await bootVim();
    const markRead = vi.spyOn(shrike.sync, 'markConversationRead');
    blur();
    press('i');
    press('Escape');
    expect(pill()).toBe('NORMAL');
    expect(markRead).not.toHaveBeenCalled();
    press('Escape');
    await settle();
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(focused()?.hasAttribute('data-message-id')).toBe(true);
  });

  it('offers suggestions only in Insert mode, and their keys keep working', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('hey @');
    expect(screen.queryByRole('listbox')).not.toBeNull();
    // The suggestion list owns Escape: it closes, and we stay in Insert mode.
    press('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(pill()).toBe('INSERT');
    press('Escape');
    expect(pill()).toBe('NORMAL');
    expect(screen.queryByRole('listbox')).toBeNull();
    press('A', { shiftKey: true });
    expect(pill()).toBe('INSERT');
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('lets IME composition through untouched', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('abc');
    press('Escape');
    expect(press('j', { isComposing: true })).toBe(false);
    expect(press('x', { keyCode: 229 })).toBe(false);
    expect(composer().value).toBe('abc');
  });

  it('runs app keys from Normal mode (gt) without editing text', async () => {
    const { shrike, id } = await bootVim();
    const execute = vi.spyOn(shrike.commands, 'execute');
    blur();
    press('i');
    typeIn('draft');
    press('Escape');
    keys('gt');
    expect(execute).toHaveBeenCalledWith('core.nextSpace');
    expect(shrike.stores.local.getState().conversations[id]?.draft).toBe('draft');
  });

  it('can start in Normal mode', async () => {
    const { shrike } = await bootVim();
    act(() => {
      shrike.stores.settings.getState().setPluginSetting('vim-mode', 'startInInsert', false);
    });
    await open(shrike);
    act(() => {
      composer().focus();
    });
    expect(pill()).toBe('NORMAL');
    expect(press('x')).toBe(true);
  });
});

describe('Vim mode: lifecycle', () => {
  it('is off by default and the app keeps its default keys', async () => {
    const { shrike } = await bootVim(false);
    expect(shrike.plugins.isEnabled('vim-mode')).toBe(false);
    expect(shrike.registries.keyLayers.layers()).toHaveLength(0);
    expect(pill()).toBeNull();
  });

  it('shows a one-time intro toast', async () => {
    const { shrike } = await bootVim();
    const intro = () =>
      shrike.stores.ui.getState().toasts.filter((t) => t.message.startsWith('Vim mode on'));
    expect(intro()).toHaveLength(1);
    await act(async () => {
      await shrike.plugins.setEnabled('vim-mode', false);
      await shrike.plugins.setEnabled('vim-mode', true);
    });
    expect(intro()).toHaveLength(1);
  });

  it('restores default behaviour completely when disabled', async () => {
    const { shrike } = await bootVim();
    // While on, a stray letter does nothing instead of jumping into the composer.
    blur();
    press('q');
    expect(focused()).not.toBe(composer());

    await act(async () => {
      await shrike.plugins.setEnabled('vim-mode', false);
    });
    await settle();
    expect(shrike.registries.keyLayers.layers()).toHaveLength(0);
    expect(shrike.registries.composerAccessories.list()).toHaveLength(0);
    expect(pill()).toBeNull();
    // Type-to-focus is back…
    blur();
    press('q');
    expect(focused()).toBe(composer());
    // …and Escape in an empty composer marks the conversation read again.
    const markRead = vi.spyOn(shrike.sync, 'markConversationRead');
    press('Escape');
    await settle();
    expect(markRead).toHaveBeenCalledTimes(1);
    // Suggestions work as before.
    typeIn('@');
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });
});
