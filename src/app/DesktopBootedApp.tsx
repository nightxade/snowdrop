/**
 * Builds the real Snowdrop instance once encrypted storage is unlocked
 * (`StorageGate`) and renders what `src/main.tsx` renders for the browser
 * build: safe mode (?safe=1 or a held Shift), native dev tools in
 * development, and a flush on page hide.
 */
import { useEffect, useState } from 'react';
import type { KeyValueStorage, MessageRepository } from '@/core/persistence';
import type { ThemeDocument } from '@/core/themes';
import { App } from './App';
import { createSnowdrop } from './createSnowdrop';
import { installBootHelpers } from './installBootHelpers';
import { SnowdropProvider } from './SnowdropProvider';

export interface DesktopBootedAppProps {
  storage: KeyValueStorage;
  repository: MessageRepository;
  document?: ThemeDocument;
}

export function DesktopBootedApp({ storage, repository, document }: DesktopBootedAppProps) {
  const [{ snowdrop, safeMode }] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const safe = params.get('safe') === '1';
    return {
      snowdrop: createSnowdrop({
        ...(document ? { document } : {}),
        safeMode: safe,
        storage,
        repository,
      }),
      safeMode: safe,
    };
  });

  useEffect(() => installBootHelpers({ snowdrop, safeMode }), [snowdrop, safeMode]);

  return (
    <SnowdropProvider snowdrop={snowdrop}>
      <App
        onBackendChange={() => {
          snowdrop.flush();
          window.location.reload();
        }}
      />
    </SnowdropProvider>
  );
}
