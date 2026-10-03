import { useSyncExternalStore } from 'react';
import type { PluginInfo } from '@/core/plugins';
import { useSnowdrop } from '@/ui/hooks';

export function usePlugins(): readonly PluginInfo[] {
  const { plugins } = useSnowdrop();
  return useSyncExternalStore(
    (fn) => plugins.subscribe(fn),
    () => plugins.list(),
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === 'string' ? error : 'Unknown error';
}

export type PluginFilter = 'all' | 'enabled' | 'disabled';

/** Pure filter for the plugins grid (exported for tests). */
export function filterPlugins(
  list: readonly PluginInfo[],
  options: { query: string; filter: PluginFilter; tag: string | null },
): PluginInfo[] {
  const terms = options.query.toLowerCase().split(/\s+/u).filter(Boolean);
  return list.filter(({ definition: d, enabled }) => {
    if (options.filter === 'enabled' && !enabled) return false;
    if (options.filter === 'disabled' && enabled) return false;
    if (options.tag && !(d.tags ?? []).includes(options.tag)) return false;
    const text = [d.name, d.description, ...(d.tags ?? []), ...d.authors].join(' ').toLowerCase();
    return terms.every((t) => text.includes(t));
  });
}
