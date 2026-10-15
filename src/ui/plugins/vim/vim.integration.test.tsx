import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createSnowdrop, SnowdropProvider, type Snowdrop } from '@/app';
import { CoreCommand } from '@/core/commands';
import type { ConversationId } from '@/core/domain';
import { createMemoryStorage } from '@/core/persistence';
import { HOME, spacesSelectors, uiSelectors } from '@/core/stores';
import { setViewport } from '@/test/bootDemo';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const live: Snowdrop[] = [];

beforeEach(() => {
  setViewport(1440);
});

afterEach(async () => {
  cleanup();
  for (const s of live.splice(0)) await s.dispose();
});

/** Boots the whole app on the demo, with Virtuoso rendering rows despite happy-dom's missing layout. */
async function boot(): Promise<Snowdrop> {
  const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  live.push(snowdrop);
  snowdrop.stores.settings.getState().update('connection', { mockLiveliness: false });
  render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 60 }}>
      <SnowdropProvider snowdrop={snowdrop}>
        <App />
      </SnowdropProvider>
    </VirtuosoMockContext.Provider>,
  );
  // The welcome screen is a lazy chunk: wait for it (outside act, so it can render).
  const demo = await screen.findByRole('button', { name: /Try the demo/u }, { timeout: 5000 });
  await act(async () => {
    fireEvent.click(demo);
    await Promise.resolve();
  });
  await act(async () => {
    await snowdrop.start();
    await snowdrop.sync.idle();
  });
  return snowdrop;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

/** Opens a conversation in its own space, as the sidebar would. */
async function open(snowdrop: Snowdrop, title?: string): Promise<ConversationId> {
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find((c) =>
    title === undefined ? c.kind === 'direct' : c.title === title,
  )!;
  const space = spacesSelectors.spaceOf(conv.id)(snowdrop.stores.spaces.getState()) ?? HOME;
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id, space);
    await snowdrop.history.open(conv.id);
  });
  await settle();
  return conv.id;
}

const rows = () => [
  ...document.querySelectorAll<HTMLElement>('[data-snowdrop="message"][data-roving-item]'),
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
  const snowdrop = await boot();
  const id = await open(snowdrop, 'Orchard · Engineering');
  await showRows();
  if (enable) {
    await act(async () => {
      await snowdrop.plugins.setEnabled('vim-mode', true);
    });
    await settle();
  }
  return { snowdrop, id };
}

const composer = () =>
  document.querySelector<HTMLTextAreaElement>('[data-snowdrop="composer"] textarea')!;
const pill = () => document.querySelector('[data-snowdrop="vim-mode"]')?.textContent ?? null;
const focused = () => document.activeElement as HTMLElement | null;

const sidebarRowFor = (id: ConversationId) =>
  document.querySelector<HTMLElement>(
    `[data-snowdrop="sidebar"] [data-roving-item][data-conversation-id="${id}"]`,
  )!;

/** True once focus is on the message list: a rendered row or the scroller. */
const onMessageList = (): boolean => {
  const el = focused();
  if (!el) return false;
  if (el.hasAttribute('data-message-scroller')) return true;
  return el.hasAttribute('data-roving-item') && el.hasAttribute('data-message-id');
};

/** Lets a requestAnimationFrame-deferred focus move (followConversationOpenFocus,
 * followConversationFocus) land before assertions. */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => {
      requestAnimationFrame(() => setTimeout(r, 0));
    });
  });
}

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
    await settle(); // counted runs execute one after another
    expect(rows().indexOf(focused()!)).toBe(first - 4);
    press('j');
    expect(rows().indexOf(focused()!)).toBe(first - 3);
    expect(focused()?.getAttribute('tabindex')).toBe('0');
  });

  it('marks the current row with a stable data-current attribute, not the previous one', async () => {
    await bootVim();
    blur();
    press('j');
    const afterFirst = rows();
    const firstIndex = afterFirst.indexOf(focused()!);
    expect(afterFirst[firstIndex]?.hasAttribute('data-current')).toBe(true);
    expect(afterFirst.filter((r) => r.hasAttribute('data-current'))).toHaveLength(1);
    press('k');
    const afterSecond = rows();
    const secondIndex = afterSecond.indexOf(focused()!);
    expect(secondIndex).toBe(firstIndex - 1);
    expect(afterSecond[secondIndex]?.hasAttribute('data-current')).toBe(true);
    expect(afterSecond[firstIndex]?.hasAttribute('data-current')).toBe(false);
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
    const { snowdrop, id } = await bootVim();
    const selected = () => uiSelectors.selectedConversation(snowdrop.stores.ui.getState());
    blur();
    press('J', { shiftKey: true });
    const next = selected();
    expect(next).not.toBe(id);
    press('K', { shiftKey: true });
    expect(selected()).toBe(id);
    keys('2J');
    await settle(); // counted runs execute one after another
    const two = selected();
    blur(); // focus followed the switch; navigate from the list again
    keys('2K');
    await settle();
    expect(selected()).toBe(id);
    blur();
    keys('JJ');
    expect(selected()).toBe(two);
  });

  it('runs app commands: ]u, gt, :, ? and the leader', async () => {
    const { snowdrop } = await bootVim();
    const execute = vi.spyOn(snowdrop.commands, 'execute');
    blur();
    keys(']u');
    keys('gt');
    expect(execute).toHaveBeenCalledWith(CoreCommand.NextUnread);
    expect(execute).toHaveBeenCalledWith('core.nextSpace');
    press(' ');
    press('s');
    expect(execute).toHaveBeenCalledWith(CoreCommand.OpenSettings);
    act(() => {
      snowdrop.stores.ui.getState().closeModal();
    });
    blur();
    press(':');
    expect(snowdrop.stores.ui.getState().modal).toEqual({
      type: 'switcher',
      props: { query: '>' },
    });
  });

  it('lists its keys in the shortcut sheet while enabled', async () => {
    await bootVim();
    blur();
    press('?');
    await settle();
    expect(screen.getByRole('heading', { name: 'Vim · Navigation' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Vim · Composer (Normal mode)' })).toBeTruthy();
    expect(screen.getByText(/caret at the end of the draft/u)).toBeTruthy();
  });

  it('clears a pending sequence with Esc and drops it after the timeout', async () => {
    const { snowdrop } = await bootVim();
    const execute = vi.spyOn(snowdrop.commands, 'execute');
    blur();
    press('g');
    expect(press('Escape')).toBe(true);
    press('t');
    expect(execute).not.toHaveBeenCalledWith('core.nextSpace');
  });

  it('acts on the focused message: r replies into Insert mode, dd asks first', async () => {
    const { snowdrop, id } = await bootVim();
    blur();
    press('j');
    const messageId = focused()?.dataset.messageId;
    press('r');
    await settle();
    expect(snowdrop.stores.ui.getState().replyTo[id]).toBe(messageId);
    expect(focused()).toBe(composer());
    expect(pill()).toBe('INSERT');
    press('Escape');
    press('Escape'); // Normal-mode Esc: cancels the reply first
    expect(snowdrop.stores.ui.getState().replyTo[id]).toBeUndefined();
    blur();
    press('j');
    keys('dd');
    await settle();
    expect(screen.getByRole('dialog', { name: /Delete for/u })).toBeTruthy();
  });
});

describe('Vim mode: focus-composer keys from anywhere', () => {
  const sidebarRow = () =>
    document.querySelector<HTMLElement>(
      '[data-snowdrop="sidebar"] [data-roving-item][data-conversation-id]',
    )!;

  it('i focuses the composer from a sidebar row (a non-text, non-list control)', async () => {
    await bootVim();
    const row = sidebarRow();
    act(() => {
      row.focus();
    });
    expect(focused()).toBe(row);
    press('i');
    expect(focused()).toBe(composer());
    expect(pill()).toBe('INSERT');
  });

  it('gi focuses the composer with the caret at the end of the draft, from anywhere', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('draft so far');
    press('Escape');
    const row = sidebarRow();
    act(() => {
      row.focus();
    });
    press('g');
    press('i');
    expect(focused()).toBe(composer());
    expect(pill()).toBe('INSERT');
    const el = composer();
    expect(el.selectionStart).toBe(el.value.length);
    expect(el.selectionEnd).toBe(el.value.length);
  });

  it('never blocks Space or Enter on a focused button', async () => {
    await bootVim();
    const row = sidebarRow();
    act(() => {
      row.focus();
    });
    expect(press(' ')).toBe(false);
    expect(press('Enter')).toBe(false);
  });

  it('stays inert in a text input (the quick switcher)', async () => {
    await bootVim();
    blur();
    press('k', { ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Quick switcher' });
    expect(focused()).toBe(input);
    expect(press('i')).toBe(false);
    expect(focused()).toBe(input);
    expect(focused()).not.toBe(composer());
  });
});

describe('Vim mode: opening a conversation never leaves focus in the composer', () => {
  // Same space as 'Orchard · Engineering' (bootVim's conversation), so its row
  // renders in the same sidebar view without switching spaces.
  const otherConversation = (snowdrop: Snowdrop): ConversationId =>
    Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.title === 'Orchard · Design Crit',
    )!.id;

  it('a sidebar click with the composer focused lands on the message list, not the composer', async () => {
    const { snowdrop } = await bootVim();
    blur();
    press('i');
    expect(focused()).toBe(composer());
    const other = otherConversation(snowdrop);
    act(() => {
      fireEvent.click(sidebarRowFor(other));
    });
    await settleFrame();
    expect(uiSelectors.selectedConversation(snowdrop.stores.ui.getState())).toBe(other);
    expect(focused()).not.toBe(composer());
    expect(focused()).not.toBe(document.body);
    expect(onMessageList()).toBe(true);
  });

  it('J/K from the list lands on the list', async () => {
    const { snowdrop, id } = await bootVim();
    blur();
    press('j');
    expect(onMessageList()).toBe(true);
    press('J', { shiftKey: true });
    await settleFrame();
    expect(uiSelectors.selectedConversation(snowdrop.stores.ui.getState())).not.toBe(id);
    expect(onMessageList()).toBe(true);
  });

  it('J/K from a sidebar row stays on the sidebar (inert: not bound to i/a/I/A/gi)', async () => {
    const { snowdrop, id } = await bootVim();
    const row = sidebarRowFor(id);
    act(() => {
      row.focus();
    });
    press('J', { shiftKey: true });
    expect(focused()).toBe(row);
    expect(focused()).not.toBe(composer());
    expect(uiSelectors.selectedConversation(snowdrop.stores.ui.getState())).toBe(id);
  });

  it('a printable key on a sidebar row does not focus the composer', async () => {
    const { id } = await bootVim();
    const row = sidebarRowFor(id);
    act(() => {
      row.focus();
    });
    expect(press('q')).toBe(false);
    expect(focused()).toBe(row);
    expect(focused()).not.toBe(composer());
  });

  it('outside Vim mode, a sidebar click leaves focus on the clicked row', async () => {
    const { snowdrop } = await bootVim(false);
    act(() => {
      composer().focus();
    });
    expect(focused()).toBe(composer());
    const other = otherConversation(snowdrop);
    const row = sidebarRowFor(other);
    act(() => {
      fireEvent.click(row);
    });
    await settleFrame();
    expect(uiSelectors.selectedConversation(snowdrop.stores.ui.getState())).toBe(other);
    // No focus policy is registered, so `followConversationOpenFocus` is a
    // no-op; but `ConversationRow`'s own click handler still focuses the
    // row it was given (WebKitGTK doesn't do this on click natively), so
    // roving focus and arrow-key stepping keep following it.
    expect(focused()).toBe(row);
  });

  it('outside Vim mode, type-to-focus still sends a stray letter to the composer', async () => {
    const { snowdrop } = await bootVim(false);
    blur();
    expect(snowdrop.plugins.isEnabled('vim-mode')).toBe(false);
    press('q');
    expect(focused()).toBe(composer());
  });
});

describe('Vim mode: Esc returns to Normal mode from anywhere', () => {
  const railTile = () =>
    document.querySelector<HTMLElement>('[data-snowdrop="rail"] button[data-roving-item]')!;

  it('from a sidebar row: focuses the message list, and j/k work right after', async () => {
    const { id } = await bootVim();
    const row = sidebarRowFor(id);
    act(() => {
      row.focus();
    });
    expect(press('Escape')).toBe(true);
    await settle();
    // FocusMessages lands on the roving tab stop's current row (the newest
    // message, here), so k (not j, already at the end) proves it's live.
    expect(onMessageList()).toBe(true);
    const current = focused();
    press('k');
    expect(focused()).not.toBe(current);
    expect(onMessageList()).toBe(true);
  });

  it('from a rail tile: focuses the message list', async () => {
    await bootVim();
    act(() => {
      railTile().focus();
    });
    expect(press('Escape')).toBe(true);
    await settle();
    expect(onMessageList()).toBe(true);
  });

  it('from a header button (Settings): focuses the message list, and J/K work right after', async () => {
    const { snowdrop, id } = await bootVim();
    const settingsButton = screen.getByRole('button', { name: 'Settings' });
    act(() => {
      settingsButton.focus();
    });
    expect(press('Escape')).toBe(true);
    await settle();
    expect(onMessageList()).toBe(true);
    press('J', { shiftKey: true });
    await settleFrame();
    expect(uiSelectors.selectedConversation(snowdrop.stores.ui.getState())).not.toBe(id);
    expect(onMessageList()).toBe(true);
  });

  it('from an empty sidebar search field: focuses the message list', async () => {
    const { snowdrop } = await bootVim();
    await act(async () => {
      await snowdrop.commands.execute(CoreCommand.SearchConversation);
    });
    const input = await screen.findByRole('searchbox', { name: 'Search messages' });
    expect(focused()).toBe(input);
    expect(press('Escape')).toBe(true);
    await settle();
    expect(onMessageList()).toBe(true);
  });

  it('from a non-empty sidebar search field: its own Escape clears it instead', async () => {
    const { snowdrop } = await bootVim();
    await act(async () => {
      await snowdrop.commands.execute(CoreCommand.SearchConversation);
    });
    const input = await screen.findByRole<HTMLInputElement>('searchbox', {
      name: 'Search messages',
    });
    fireEvent.change(input, { target: { value: 'orchard' } });
    expect(press('Escape')).toBe(true); // SearchInput's own handler prevents default
    expect(input.value).toBe('');
    expect(focused()).toBe(input);
    // A second, now-empty Escape reaches the message list like (1).
    expect(press('Escape')).toBe(true);
    await settle();
    expect(onMessageList()).toBe(true);
  });
});

describe('Vim mode: composer', () => {
  it('starts in Insert mode, Esc gives Normal with a block cursor, Enter sends', async () => {
    const { snowdrop } = await bootVim();
    const send = vi.spyOn(snowdrop.send, 'send');
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
    const { snowdrop } = await bootVim();
    const markRead = vi.spyOn(snowdrop.sync, 'markConversationRead');
    blur();
    press('i');
    press('Escape');
    expect(pill()).toBe('NORMAL');
    expect(markRead).not.toHaveBeenCalled();
    press('Escape');
    await settle();
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(focused()?.hasAttribute('data-message-id')).toBe(true);
    expect(focused()).toBe(rows().at(-1));
  });

  it('returns to the newest message, not wherever the list was last left, when leaving an empty composer', async () => {
    await bootVim();
    blur();
    // Move the roving tab stop off the newest message before entering the composer.
    keys('3k');
    await settle();
    const older = focused();
    expect(older).not.toBe(rows().at(-1));
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    press('i');
    press('Escape'); // Insert -> Normal
    press('Escape'); // Normal, empty draft -> back to the messages
    await settle();
    expect(focused()).toBe(rows().at(-1));
    expect(focused()).not.toBe(older);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'end' }));
  });

  it('offers suggestions only in Insert mode, and their keys keep working', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('hey @');
    expect(await screen.findByRole('listbox')).toBeTruthy();
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

  it('turns IME input in Normal mode into one Insert change (no lost character, one undo)', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('hello brae');
    press('Escape');
    press('0');
    const el = composer();
    // The block cursor selects "h"; an IME composition would replace it.
    expect(el.value.slice(el.selectionStart, el.selectionEnd)).toBe('h');
    act(() => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    });
    // Insert mode with a collapsed caret before the composition lands.
    expect(pill()).toBe('INSERT');
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 0]);
    // The browser inserts the composed text at the caret.
    act(() => {
      el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'に' }));
    });
    const value = `に${el.value}`;
    fireEvent.change(el, { target: { value } });
    el.setSelectionRange(1, 1);
    fireEvent.select(el);
    act(() => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'に' }));
    });
    expect(composer().value).toBe('にhello brae');
    press('Escape');
    expect(pill()).toBe('NORMAL');
    // One undo step removes exactly the composed text…
    press('u');
    expect(composer().value).toBe('hello brae');
    // …and "." repeats it like "i".
    press('.');
    expect(composer().value).toBe('にhello brae');
  });

  it('enters Insert mode on the IME keydown (keyCode 229) before compositionstart', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('abc');
    press('Escape');
    expect(pill()).toBe('NORMAL');
    expect(press('Process', { keyCode: 229 })).toBe(false);
    expect(pill()).toBe('INSERT');
    const el = composer();
    expect(el.selectionStart).toBe(el.selectionEnd);
    expect(el.value).toBe('abc');
  });

  it('describes the composer with the current mode', async () => {
    await bootVim();
    blur();
    press('i');
    press('Escape');
    const el = composer();
    const id = el.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)?.textContent).toBe('Vim: Normal mode');
    press('i');
    expect(document.getElementById(id!)?.textContent).toBe('Vim: Insert mode');
  });

  it('runs app keys from Normal mode (gt) without editing text', async () => {
    const { snowdrop, id } = await bootVim();
    const execute = vi.spyOn(snowdrop.commands, 'execute');
    blur();
    press('i');
    typeIn('draft');
    press('Escape');
    keys('gt');
    expect(execute).toHaveBeenCalledWith('core.nextSpace');
    expect(snowdrop.stores.local.getState().conversations[id]?.draft).toBe('draft');
  });

  it('can start in Normal mode', async () => {
    const { snowdrop } = await bootVim();
    act(() => {
      snowdrop.stores.settings.getState().setPluginSetting('vim-mode', 'startInInsert', false);
    });
    await open(snowdrop);
    act(() => {
      composer().focus();
    });
    expect(pill()).toBe('NORMAL');
    expect(press('x')).toBe(true);
  });
});

describe('Vim mode: block cursor', () => {
  const caret = () => document.querySelector<HTMLElement>('[data-snowdrop="vim-caret"]');
  const selected = () => {
    const el = composer();
    return el.value.slice(el.selectionStart, el.selectionEnd);
  };

  it('shows a block in an empty composer, and again after a send clears it', async () => {
    await bootVim();
    blur();
    press('i');
    expect(caret()).toBeNull();
    press('Escape');
    await settle();
    expect(caret()).not.toBeNull();
    expect(caret()?.dataset.focused).toBe('true');
    expect(caret()?.dataset.vimMode).toBe('normal');
    expect(caret()?.textContent).toBe('');
    // Drawn over the field, not in the accessory slot.
    expect(caret()?.closest('[data-slot]')).toBeNull();
    expect(caret()?.closest('[data-snowdrop="composer"]')).not.toBeNull();

    press('i');
    typeIn('sent');
    press('Escape');
    await settle();
    expect(caret()?.textContent).toBe('t');
    press('Enter');
    await settle();
    expect(composer().value).toBe('');
    expect(caret()?.textContent).toBe('');
  });

  it('covers the last character with $, and a line end in Visual mode', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('one two\n\nthree');
    press('Escape');
    keys('gg$');
    await settle();
    expect(selected()).toBe('o');
    expect(caret()?.textContent).toBe('o');
    keys('vj');
    await settle();
    expect(caret()?.dataset.vimMode).toBe('visual');
    // The cursor end is the blank line's break: an empty cell, not a vanished caret.
    expect(selected()).toBe('o\n\n');
    expect(caret()?.textContent).toBe('');
  });

  it('shows on a blank line between lines', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('one\n\ntwo');
    press('Escape');
    keys('k');
    await settle();
    const el = composer();
    expect(el.selectionStart).toBe(4);
    expect(el.selectionEnd).toBe(4);
    expect(caret()).not.toBeNull();
    expect(caret()?.textContent).toBe('');
    keys('k');
    await settle();
    // Back up with the goal column ("two" → col 2).
    expect(caret()?.textContent).toBe('e');
  });

  it('hides in Insert mode (the native caret is back) and returns on Esc', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('abc');
    press('Escape');
    await settle();
    expect(caret()?.textContent).toBe('c');
    press('i');
    await settle();
    expect(caret()).toBeNull();
    press('Escape');
    await settle();
    expect(caret()?.textContent).toBe('b');
  });

  it('keeps the selection in Visual mode and puts the block on its moving end', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('hello world');
    press('Escape');
    keys('0ve');
    await settle();
    expect(selected()).toBe('hello');
    expect(caret()?.dataset.vimMode).toBe('visual');
    expect(caret()?.textContent).toBe('o');
    keys('o');
    await settle();
    // "o" swaps ends: the cursor is now at the start of the selection.
    expect(selected()).toBe('hello');
    expect(caret()?.textContent).toBe('h');
    press('Escape');
    await settle();
    expect(caret()?.dataset.vimMode).toBe('normal');
  });

  it('turns hollow while the composer is unfocused', async () => {
    await bootVim();
    blur();
    press('i');
    typeIn('abc');
    press('Escape');
    await settle();
    expect(caret()?.dataset.focused).toBe('true');
    blur();
    await settle();
    expect(caret()?.dataset.focused).toBe('false');
    expect(caret()?.textContent).toBe('');
  });
});

describe('Vim mode: lifecycle', () => {
  it('is off by default and the app keeps its default keys', async () => {
    const { snowdrop } = await bootVim(false);
    expect(snowdrop.plugins.isEnabled('vim-mode')).toBe(false);
    expect(snowdrop.registries.keyLayers.layers()).toHaveLength(0);
    expect(pill()).toBeNull();
  });

  it('shows a one-time intro toast', async () => {
    const { snowdrop } = await bootVim();
    const intro = () =>
      snowdrop.stores.ui.getState().toasts.filter((t) => t.message.startsWith('Vim mode on'));
    expect(intro()).toHaveLength(1);
    await act(async () => {
      await snowdrop.plugins.setEnabled('vim-mode', false);
      await snowdrop.plugins.setEnabled('vim-mode', true);
    });
    expect(intro()).toHaveLength(1);
  });

  it('restores default behaviour completely when disabled', async () => {
    const { snowdrop } = await bootVim();
    // While on, a stray letter does nothing instead of jumping into the composer.
    blur();
    press('q');
    expect(focused()).not.toBe(composer());

    await act(async () => {
      await snowdrop.plugins.setEnabled('vim-mode', false);
    });
    await settle();
    expect(snowdrop.registries.keyLayers.layers()).toHaveLength(0);
    expect(snowdrop.registries.composerAccessories.list()).toHaveLength(0);
    expect(pill()).toBeNull();
    expect(document.querySelector('[data-snowdrop="vim-caret"]')).toBeNull();
    // Type-to-focus is back…
    blur();
    press('q');
    expect(focused()).toBe(composer());
    // …and Escape in an empty composer marks the conversation read again.
    const markRead = vi.spyOn(snowdrop.sync, 'markConversationRead');
    press('Escape');
    await settle();
    expect(markRead).toHaveBeenCalledTimes(1);
    // Suggestions work as before.
    typeIn('@');
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('shows its NORMAL/INSERT mode on the TUI shell status line, beside core’s items', async () => {
    const { snowdrop } = await bootVim();
    act(() => {
      snowdrop.stores.settings.getState().update('appearance', { shell: 'tui' });
    });
    await settle();

    const statusLine = document.querySelector('[data-snowdrop="status-line"]')!;
    expect(statusLine).not.toBeNull();
    // Core's own item (the open conversation) and the plugin's (the mode) sit
    // in the same slot, in registration order — core first. The composer
    // starts in Insert by default (Vim Mode's own "Start in Insert" setting).
    expect(statusLine.textContent).toContain('Orchard · Engineering');
    expect(statusLine.textContent).toContain('INSERT');

    composer().focus();
    press('Escape');
    expect(statusLine.textContent).toContain('NORMAL');

    // Toggling back to the standard shell unmounts it (no stale listeners).
    act(() => {
      snowdrop.stores.settings.getState().update('appearance', { shell: 'standard' });
    });
    await settle();
    expect(document.querySelector('[data-snowdrop="status-line"]')).toBeNull();
  });
});
