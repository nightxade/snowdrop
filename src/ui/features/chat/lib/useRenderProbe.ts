import { useEffect } from 'react';

interface ProbeWindow {
  __renders?: Record<string, number>;
  __listRenders?: number;
}

/**
 * Dev-only commit counter for profiling scripts (`window.__renders[id]`,
 * `window.__listRenders`). A no-op in production builds.
 */
export function useRenderProbe(key: string | null): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as ProbeWindow;
    if (key === null) w.__listRenders = (w.__listRenders ?? 0) + 1;
    else (w.__renders ??= {})[key] = (w.__renders[key] ?? 0) + 1;
  });
}
