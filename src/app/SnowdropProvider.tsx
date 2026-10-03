import { createContext, use, useCallback, type ReactNode } from 'react';
import { SnowdropContextProvider } from '@/ui/hooks';
import { PluginNamesContext } from '@/ui/primitives';
import type { Snowdrop } from './createSnowdrop';

const SnowdropContext = createContext<Snowdrop | null>(null);

/**
 * Makes the composed app available to the React tree: the full `Snowdrop` for
 * app/ code, and the `AppServices` view of it for ui/ features.
 */
export function SnowdropProvider({
  snowdrop,
  children,
}: {
  snowdrop: Snowdrop;
  children: ReactNode;
}) {
  // Crash chips name the plugin ("Message Tools failed"), not its id.
  const nameFor = useCallback(
    (owner: string) => snowdrop.plugins.get(owner)?.definition.name ?? owner,
    [snowdrop],
  );
  return (
    <SnowdropContext value={snowdrop}>
      <SnowdropContextProvider value={snowdrop}>
        <PluginNamesContext value={nameFor}>{children}</PluginNamesContext>
      </SnowdropContextProvider>
    </SnowdropContext>
  );
}

export function useSnowdrop(): Snowdrop {
  const snowdrop = use(SnowdropContext);
  if (!snowdrop) throw new Error('useSnowdrop must be used inside <SnowdropProvider>');
  return snowdrop;
}
