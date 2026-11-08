// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import { Directory } from './directory';
import { SelfIdentity } from './identity';
import type { JsonRpcClient } from './rpc';

const SELF = '00000000-0000-4000-8000-000000000001';

function directory(call: (method: string) => Promise<unknown>) {
  const scheduler = new ManualScheduler(0);
  const callSpy = vi.fn(call);
  const rpc = { call: callSpy } as unknown as JsonRpcClient;
  const dir = new Directory({
    rpc,
    now: () => scheduler.now(),
    scheduler,
    identity: () => new SelfIdentity(SELF, [SELF]),
    peers: () => null,
    onContactChanged: () => undefined,
    onGroupChanged: () => undefined,
    debug: () => undefined,
  });
  return { dir, rpc: callSpy };
}

describe('Directory loading', () => {
  it('shares one in-flight load, and an old load finishing after reset keeps the new one shared', async () => {
    const releases: (() => void)[] = [];
    const { dir, rpc } = directory(
      () =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve([]);
          });
        }),
    );
    const first = dir.loadContacts(true);
    dir.reset(); // a new account/reconnect
    const second = dir.loadContacts(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    // The old request finishing must not clear the new request's in-flight promise.
    releases[0]!();
    await first;
    const third = dir.loadContacts(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    releases[1]!();
    await Promise.all([second, third]);
  });
});
