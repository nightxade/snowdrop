import { useStore } from 'zustand';
import { useStores } from './SnowdropContext';

/**
 * True when Appearance → Layout is "TUI" (`appearance.shell === 'tui'`).
 * Almost everything about that shell is pure CSS (`src/ui/styles/tui.css`,
 * scoped under `:root[data-shell='tui']`); this hook is only for the few
 * places markup itself must differ — the rail's text list, forcing compact
 * message rows regardless of the density setting, and mounting the status
 * line.
 */
export function useShellStyle(): boolean {
  const stores = useStores();
  return useStore(stores.settings, (s) => s.appearance.shell === 'tui');
}
