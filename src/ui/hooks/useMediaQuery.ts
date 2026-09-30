import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', fn);
      return () => {
        mql.removeEventListener('change', fn);
      };
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Layout breakpoints from PLAN §4.1. */
export const BREAKPOINTS = {
  /** Member list becomes an overlay sheet below this width. */
  members: '(max-width: 1099.98px)',
  /** Rail + sidebar collapse into a drawer below this width. */
  drawer: '(max-width: 759.98px)',
} as const;
