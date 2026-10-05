/**
 * `storageKeyringStatus` against a fake `TauriIpc` — no `@tauri-apps/api`
 * mocking needed since the function takes its `ipc` as a parameter.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  storageCreateRecovery,
  storageEnrollKeyring,
  storageEraseAll,
  storageKeyringStatus,
  storageRemoveRecovery,
  storageSetPassphrase,
  storageSetup,
  storageSignOut,
  storageStatus,
  storageUnlock,
  storageWebcacheKey,
} from './desktop';
import type { TauriIpc } from './ipc';

function fakeIpc(result: unknown): TauriIpc {
  return {
    invoke: <T>() => Promise.resolve(result as T),
    listen: () => Promise.resolve(() => {}),
  };
}

/** For tests that need to inspect what was sent, not just the reply. */
function fakeIpcWithInvoke(invoke: TauriIpc['invoke']): TauriIpc {
  return { invoke, listen: () => Promise.resolve(() => {}) };
}

const okStatus = {
  state: 'unlocked',
  reason: null,
  hasRecovery: false,
  hasPassphrase: false,
  hasKeyring: true,
  keyringBackend: 'secret-service',
  legacyPlaintext: false,
  vaultDisabled: false,
  restartRequired: false,
};

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

describe('storageStatus', () => {
  it('decodes a well-formed reply', async () => {
    await expect(storageStatus(fakeIpc(okStatus))).resolves.toEqual(okStatus);
  });

  it('decodes a locked reply with a reason', async () => {
    const locked = { ...okStatus, state: 'locked', reason: 'passphraseRequired', hasKeyring: false };
    await expect(storageStatus(fakeIpc(locked))).resolves.toEqual(locked);
  });

  it('rejects an unknown state', async () => {
    await expect(storageStatus(fakeIpc({ ...okStatus, state: 'running' }))).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('rejects an unknown reason', async () => {
    await expect(
      storageStatus(fakeIpc({ ...okStatus, state: 'locked', reason: 'somethingElse' })),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('storageSetup', () => {
  it('sends the mode and passphrase, and decodes the status', async () => {
    const invoke = vi.fn().mockResolvedValue(okStatus);
    await expect(storageSetup('keyring', null, fakeIpcWithInvoke(invoke))).resolves.toEqual(
      okStatus,
    );
    expect(invoke).toHaveBeenCalledWith('storage_setup', { mode: 'keyring', passphrase: null });
  });
});

describe('storageUnlock', () => {
  it('sends the method, secret and remember flag', async () => {
    const invoke = vi.fn().mockResolvedValue(okStatus);
    await storageUnlock('recovery', 'ABCD-1234', true, fakeIpcWithInvoke(invoke));
    expect(invoke).toHaveBeenCalledWith('storage_unlock', {
      method: 'recovery',
      secret: 'ABCD-1234',
      remember: true,
    });
  });
});

describe('storageCreateRecovery', () => {
  it('decodes the code and status together', async () => {
    const result = await storageCreateRecovery(fakeIpc({ code: 'AAAA-BBBB', status: okStatus }));
    expect(result).toEqual({ code: 'AAAA-BBBB', status: okStatus });
  });

  it('rejects a reply missing the code', async () => {
    await expect(storageCreateRecovery(fakeIpc({ status: okStatus }))).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });
});

describe('storageRemoveRecovery', () => {
  it('decodes the status', async () => {
    await expect(storageRemoveRecovery(fakeIpc(okStatus))).resolves.toEqual(okStatus);
  });
});

describe('storageSetPassphrase', () => {
  it('sends null to remove the passphrase', async () => {
    const invoke = vi.fn().mockResolvedValue(okStatus);
    await storageSetPassphrase(null, fakeIpcWithInvoke(invoke));
    expect(invoke).toHaveBeenCalledWith('storage_set_passphrase', { passphrase: null });
  });
});

describe('storageEnrollKeyring', () => {
  it('decodes the status', async () => {
    await expect(storageEnrollKeyring(fakeIpc(okStatus))).resolves.toEqual(okStatus);
  });
});

describe('storageWebcacheKey', () => {
  it('returns the base64 string', async () => {
    await expect(storageWebcacheKey(fakeIpc({ keyBase64: 'AAAA' }))).resolves.toBe('AAAA');
  });

  it('rejects a non-string key', async () => {
    await expect(storageWebcacheKey(fakeIpc({ keyBase64: 42 }))).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });
});

describe('storageEraseAll', () => {
  it('always confirms with the literal ERASE', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: { ...okStatus, state: 'needsSetup' }, failures: [] });
    const result = await storageEraseAll(fakeIpcWithInvoke(invoke));
    expect(invoke).toHaveBeenCalledWith('storage_erase_all', { confirm: 'ERASE' });
    expect(result).toEqual({ status: { ...okStatus, state: 'needsSetup' }, failures: [] });
  });

  it('decodes reported failures', async () => {
    const reply = { status: { ...okStatus, state: 'needsSetup' }, failures: ['keyring entry: oops'] };
    await expect(storageEraseAll(fakeIpc(reply))).resolves.toEqual(reply);
  });
});

describe('storageSignOut', () => {
  it('invokes storage_sign_out with no arguments and decodes the status', async () => {
    const reply = { ...okStatus, state: 'needsSetup', restartRequired: true };
    const invoke = vi.fn().mockResolvedValue(reply);
    const result = await storageSignOut(fakeIpcWithInvoke(invoke));
    expect(invoke).toHaveBeenCalledWith('storage_sign_out');
    expect(result).toEqual(reply);
  });
});
