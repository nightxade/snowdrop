/**
 * Everything Vim mode registers when it starts. Loaded on demand by
 * `vimPlugin.ts` (its own chunk), so the engine isn't in the main bundle
 * while the plugin is off.
 */
import type { PluginContext } from '@/core/plugins';
import { textSurfaceFor } from '@/ui/hooks';
import type { Mode } from './engine/engine';
import { makeModePill } from './ModePill';
import { ModeStore } from './modeStore';
import type { settings } from './settings';
import { VimController, type VimOptions } from './VimController';
import { makeVimKeysPanel } from './VimKeysPanel';

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

export function startVim(ctx: PluginContext<typeof settings>): void {
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

  const surfaceOf = (e: Event) => textSurfaceFor(e.target instanceof Element ? e.target : null);
  // Show the mode as soon as the composer is focused or clicked, not on the first key.
  const onFocus = (e: FocusEvent) => {
    const surface = surfaceOf(e);
    if (surface) vim.onSurfaceFocus(surface);
  };
  const onPointerUp = (e: PointerEvent) => {
    const surface = surfaceOf(e);
    if (surface) vim.onSurfacePointer(surface);
  };
  // IME input outside Insert mode: switch to Insert (caret collapsed) before
  // the composition replaces the block cursor's character. The 229 keydown
  // comes first where browsers send one; compositionstart covers the rest.
  const onImeKey = (e: KeyboardEvent) => {
    // keyCode is deprecated, but 229 is the only signal some IMEs give before composing.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (!e.isComposing && e.keyCode !== 229) return;
    const surface = surfaceOf(e);
    if (surface) vim.onCompositionStart(surface);
  };
  const onCompositionStart = (e: CompositionEvent) => {
    const surface = surfaceOf(e);
    if (surface) vim.onCompositionStart(surface);
  };
  document.addEventListener('focusin', onFocus);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('keydown', onImeKey, true);
  document.addEventListener('compositionstart', onCompositionStart, true);
  ctx.onDispose(() => {
    document.removeEventListener('focusin', onFocus);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('keydown', onImeKey, true);
    document.removeEventListener('compositionstart', onCompositionStart, true);
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
}
