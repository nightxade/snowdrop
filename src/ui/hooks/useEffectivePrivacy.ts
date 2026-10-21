import { useMemo } from 'react';
import { useStore } from 'zustand';
import { effectivePrivacy, sessionSelectors, type EffectivePrivacy } from '@/core/stores';
import { useStores } from './SnowdropContext';

/**
 * The read receipt / typing / link preview settings Snowdrop actually acts
 * on: the phone's where it has told us, Snowdrop's own otherwise (see
 * `effectivePrivacy`). Components that gate on these read it from here, never
 * from `behaviour` directly.
 */
export function useEffectivePrivacy(): EffectivePrivacy {
  const stores = useStores();
  const behaviour = useStore(stores.settings, (s) => s.behaviour);
  const phone = useStore(stores.session, sessionSelectors.phonePrivacy);
  return useMemo(() => effectivePrivacy(behaviour, phone), [behaviour, phone]);
}
