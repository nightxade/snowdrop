/**
 * Vim mode (built-in, off by default): modal keys for the whole app. A key
 * layer gives app navigation when you aren't typing (j/k, gg/G, J/K, ]u,
 * gt, message actions, a leader key) and modal editing in the composer
 * through a pure engine (engine/engine.ts). Everything it adds is undone
 * when it stops.
 *
 * Only this definition and its settings schema are in the main bundle: the
 * engine, controller and UI load as their own chunk the first time the
 * plugin starts (`startVim.ts`).
 */
import { definePlugin } from '@/core/plugins';
import { settings } from './settings';

export const vimPlugin = definePlugin({
  id: 'vim-mode',
  name: 'Vim Mode',
  description:
    'Modal keyboard control: j/k through messages, J/K through conversations, and Normal/Insert/Visual modes in the composer.',
  authors: ['snowdrop'],
  tags: ['keyboard', 'accessibility'],
  settings,
  async start(ctx) {
    const { startVim } = await import('./startVim');
    startVim(ctx);
  },
});
