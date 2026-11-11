import { useCallback, useSyncExternalStore } from 'react';
import type { Feature } from '@/core/backend';
import { useSnowdrop } from './SnowdropContext';

/** Whether the backend has `feature`, re-rendering when its set of features changes. */
export function useBackendFeature(feature: Feature): boolean {
  const { capabilities } = useSnowdrop().backend;
  const subscribe = useCallback((fn: () => void) => capabilities.subscribe(fn), [capabilities]);
  return useSyncExternalStore(subscribe, () => capabilities.features.has(feature));
}
