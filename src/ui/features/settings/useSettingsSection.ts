import { useStore } from 'zustand';
import type { Settings } from '@/core/stores';
import { useStores } from '@/ui/hooks';

type Section = 'appearance' | 'notifications' | 'behaviour' | 'connection';

/** One settings section plus a patcher, for pages that edit it live. */
export function useSettingsSection<K extends Section>(
  section: K,
): [Settings[K], (patch: Partial<Settings[K]>) => void] {
  const stores = useStores();
  const value = useStore(stores.settings, (s) => s[section]);
  return [
    value,
    (patch) => {
      stores.settings.getState().update(section, patch);
    },
  ];
}
