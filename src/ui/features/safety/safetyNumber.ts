import { useCallback, useEffect, useState } from 'react';
import type { SafetyNumber } from '@/core/backend';
import { useSnowdrop } from '@/ui/hooks';

/** The 12 groups of 5 digits, as Signal Desktop lays them out. */
export function safetyBlocks(digits: string): string[] {
  const clean = digits.replaceAll(/\s+/gu, '');
  const blocks: string[] = [];
  for (let i = 0; i < clean.length; i += 5) blocks.push(clean.slice(i, i + 5));
  return blocks;
}

export type SafetyNumberState =
  | { status: 'loading' }
  | { status: 'ready'; number: SafetyNumber }
  | { status: 'none' }
  | { status: 'failed' };

/** Reads a person's safety number when it mounts; `reload` asks again (after a change). */
export function useSafetyNumber(contactId: string): {
  state: SafetyNumberState;
  reload: () => Promise<void>;
} {
  const { identity } = useSnowdrop();
  const [state, setState] = useState<SafetyNumberState>({ status: 'loading' });
  const reload = useCallback(async () => {
    const result = await identity.load(contactId);
    setState(result);
  }, [identity, contactId]);
  useEffect(() => {
    let current = true;
    void identity.load(contactId).then((result) => {
      if (current) setState(result);
    });
    return () => {
      current = false;
    };
  }, [identity, contactId]);
  return { state, reload };
}
