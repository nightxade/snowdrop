import { createContext, use, useCallback, type ReactNode } from 'react';
import { ShrikeContextProvider } from '@/ui/hooks';
import { PluginNamesContext } from '@/ui/primitives';
import type { Shrike } from './createShrike';

const ShrikeContext = createContext<Shrike | null>(null);

/**
 * Makes the composed app available to the React tree: the full `Shrike` for
 * app/ code, and the `AppServices` view of it for ui/ features.
 */
export function ShrikeProvider({ shrike, children }: { shrike: Shrike; children: ReactNode }) {
  // Crash chips name the plugin ("Message Tools failed"), not its id.
  const nameFor = useCallback(
    (owner: string) => shrike.plugins.get(owner)?.definition.name ?? owner,
    [shrike],
  );
  return (
    <ShrikeContext value={shrike}>
      <ShrikeContextProvider value={shrike}>
        <PluginNamesContext value={nameFor}>{children}</PluginNamesContext>
      </ShrikeContextProvider>
    </ShrikeContext>
  );
}

export function useShrike(): Shrike {
  const shrike = use(ShrikeContext);
  if (!shrike) throw new Error('useShrike must be used inside <ShrikeProvider>');
  return shrike;
}
