/**
 * `storageKeyringStatus` against a fake `TauriIpc` — no `@tauri-apps/api`
 * mocking needed since the function takes its `ipc` as a parameter.
 */
import { describe, expect, it } from 'vitest';
import { storageKeyringStatus } from './desktop';
import type { TauriIpc } from './ipc';

function fakeIpc(result: unknown): TauriIpc {
  return {
    invoke: <T>() => Promise.resolve(result as T),
    listen: () => Promise.resolve(() => {}),
  };
}

describe('storageKeyringStatus', () => {
  it('decodes a well-formed reply', async () => {
    const status = await storageKeyringStatus(
      fakeIpc({ available: true, hasSecret: false, backend: 'secret-service' }),
    );
    expect(status).toEqual({ available: true, hasSecret: false, backend: 'secret-service' });
  });

  it('rejects a reply with an unknown backend', async () => {
    await expect(
      storageKeyringStatus(fakeIpc({ available: true, hasSecret: false, backend: 'kwallet' })),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('rejects a reply missing a field', async () => {
    await expect(
      storageKeyringStatus(fakeIpc({ available: true, backend: 'windows' })),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});
