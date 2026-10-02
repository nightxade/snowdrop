/**
 * Vim mode (built-in, off by default): modal keys for the whole app. A key
 * layer gives app navigation when you aren't typing (j/k, gg/G, J/K, ]u,
 * gt, message actions, a leader key) and modal editing in the composer
 * through a pure engine (engine/engine.ts). Everything it adds is undone
 * when it stops.
 */
import { definePlugin, defineSettings } from '@/core/plugins';
import { textSurfaceFor } from '@/ui/hooks';
import type { Mode } from './engine/engine';
import { LEADER_OPTIONS } from './keymap';
import { makeModePill } from './ModePill';
import { ModeStore } from './modeStore';
import { VimController, type VimOptions } from './VimController';
import { makeVimKeysPanel } from './VimKeysPanel';

const settings = defineSettings({
  navigation: {
    type: 'boolean',
    label: 'Navigation keys',
    description: 'j/k, gg/G, J/K, ]u, gt and message actions when you aren’t typing.',
    default: true,
  },
  composer: {
    type: 'boolean',
    label: 'Modal editing in the composer',
    description: 'Normal, Insert and Visual modes in the message box.',
    default: true,
  },
  startInInsert: {
    type: 'boolean',
    label: 'Start the composer in Insert mode',
    description: 'Type straight away; Esc switches to Normal mode.',
    default: true,
  },
  leader: {
    type: 'select',
    label: 'Leader key',
    description: 'Press it, then s for settings, k switcher, n notifications, p plugins.',
    default: ' ',
    options: LEADER_OPTIONS,
  },
  timeout: {
    type: 'number',
    label: 'Key sequence timeout (ms)',
    description: 'How long to wait for the next key of gg, ]u, the leader…',
    default: 1000,
    min: 300,
    max: 3000,
    step: 100,
  },
  introShown: { type: 'boolean', label: 'Intro toast shown', default: false, hidden: true },
});

/**
 * The Normal-mode block cursor is the textarea's own selection, one
 * character wide (a textarea can't draw a block caret). Stable hooks only.
 */
const CARET_CSS = `
[data-shrike='composer']:has([data-vim-mode='normal']) [data-shrike='composer-input']::selection {
  background: var(--shrike-accent);
  color: var(--shrike-text-on-accent);
}
[data-shrike='composer']:has([data-vim-mode^='visual']) [data-shrike='composer-input']::selection {
  background: color-mix(in srgb, var(--shrike-accent) 40%, transparent);
  color: var(--shrike-text-strong);
}`;

export const vimPlugin = definePlugin({
  id: 'vim-mode',
  name: 'Vim Mode',
  description:
    'Modal keyboard control: j/k through messages, J/K through conversations, and Normal/Insert/Visual modes in the composer.',
  authors: ['shrike'],
  tags: ['keyboard', 'accessibility'],
  settings,
  start(ctx) {
    const modes = new ModeStore();
    const options = (): VimOptions => {
      const v = ctx.settings.all();
      return {
        navigation: v.navigation,
        composer: v.composer,
        startInInsert: v.startInInsert,
        leader: v.leader,
        timeoutMs: v.timeout,
      };
    };
    const vim = new VimController(
      {
        options,
        execute: (id) => ctx.commands.execute(id),
        copy: (text) => {
          navigator.clipboard.writeText(text).then(
            () => {
              ctx.toast('Copied to clipboard', 'success');
            },
            () => {
              ctx.toast('Couldn’t reach the clipboard', 'error');
            },
          );
        },
        toast: (message) => {
          ctx.toast(message, 'info');
        },
        notificationsEnabled: () => ctx.stores.settings.getState().notifications.enabled,
        currentConversation: () => {
          const ui = ctx.stores.ui.getState();
          return ui.selectedConversationBySpace[ui.selectedSpace] ?? null;
        },
      },
      modes,
    );
    ctx.keys.addLayer(vim.layer);

    const subscribeOptions = (fn: () => void) => ctx.settings.subscribe(fn);
    ctx.composer.addAccessory(
      'mode-pill',
      makeModePill({
        modes,
        subscribeOptions,
        composerEnabled: () => ctx.settings.get('composer'),
        startMode: (): Mode => (ctx.settings.get('startInInsert') ? 'insert' : 'normal'),
      }),
    );
    ctx.settingsPanels.add({
      id: 'vim-keys',
      title: 'Vim keys',
      component: makeVimKeysPanel({
        subscribe: subscribeOptions,
        leader: () => ctx.settings.get('leader'),
      }),
    });
    ctx.styles.inject(CARET_CSS, 'block-caret');

    // Show the mode as soon as the composer is focused or clicked, not on the first key.
    const onFocus = (e: FocusEvent) => {
      const surface = textSurfaceFor(e.target instanceof Element ? e.target : null);
      if (surface) vim.onSurfaceFocus(surface);
    };
    const onPointerUp = (e: PointerEvent) => {
      const surface = textSurfaceFor(e.target instanceof Element ? e.target : null);
      if (surface) vim.onSurfacePointer(surface);
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('pointerup', onPointerUp);
    ctx.onDispose(() => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('pointerup', onPointerUp);
    });
    // The composer focused when Vim mode starts (enabled from the palette, say).
    const active = textSurfaceFor(document.activeElement);
    if (active) vim.onSurfaceFocus(active);

    ctx.settings.subscribe((values) => {
      if (!values.composer) vim.releaseComposers();
    });

    if (!ctx.settings.get('introShown')) {
      ctx.toast('Vim mode on — Esc for Normal mode, ? for keys', 'info');
      ctx.settings.set('introShown', true);
    }
  },
});
