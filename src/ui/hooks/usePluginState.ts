import { useSyncExternalStore } from 'react';
import type { PluginState } from '@/core/plugins';

/**
 * Reads a plugin's `ctx.state(…)` value and re-renders when it changes. Use it
 * in the components a plugin contributes (decorations, accessories, panels).
 */
export function usePluginState<T>(state: PluginState<T>): T {
  return useSyncExternalStore(
    (onChange) => state.subscribe(onChange),
    () => state.get(),
  );
}
