/**
 * The transport choice in the backend registry: the browser (and every
 * other test) never loads the desktop platform layer; inside Tauri the
 * signal-cli backend gets the IPC transport with the desktop settings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { DEFAULT_DESKTOP_CONNECTION, type DesktopConnection } from '@/core/stores';
import { BUILTIN_BACKENDS, type BackendEnvironment } from './backends';
import { desktopLogAdmin, installFlushBeforeClose, installTerminalErrorLog } from './platform';

const platform = vi.hoisted(() => ({
  loaded: 0,
  transports: [] as unknown[],
  flushHandlers: [] as (() => Promise<void>)[],
  sentLogs: [] as { level: string; scope: string; message: string }[],
  logRecentResult: 'desktop log tail',
  logSetVerbose: vi.fn((_verbose: boolean) => Promise.resolve()),
  logOpenFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/platform/tauri', () => {
  platform.loaded++;
  class TauriTransport {
    readonly resumeScope = 'desktop';
    readonly description = 'fake desktop transport';
    constructor(options: { desktop: DesktopConnection }) {
      platform.transports.push(options);
    }
  }
  return {
    TauriTransport,
    onFlushBeforeClose: (handler: () => Promise<void>) => {
      platform.flushHandlers.push(handler);
      return Promise.resolve(() => {});
    },
    sendFrontendLog: (level: string, scope: string, message: string) => {
      platform.sentLogs.push({ level, scope, message });
    },
    logRecent: () => Promise.resolve(platform.logRecentResult),
    logSetVerbose: (verbose: boolean) => platform.logSetVerbose(verbose),
    logOpenFolder: () => platform.logOpenFolder(),
  };
});

const desktop: DesktopConnection = { ...DEFAULT_DESKTOP_CONNECTION, binaryPath: '/opt/signal-cli' };
const env: BackendEnvironment = {
  clock: new ManualScheduler(0),
  scheduler: new ManualScheduler(0),
  storage: createMemoryStorage(),
  connection: {
    backend: 'signal-cli',
    daemonUrl: '/signal-cli',
    account: null,
    mockLiveliness: false,
    desktop,
  },
  updateConnection: () => undefined,
  overrides: {},
};
const signalCli = BUILTIN_BACKENDS.find((b) => b.kind === 'signal-cli')!;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('signal-cli transport choice', () => {
  it('uses HTTP in the browser, without loading the desktop platform', async () => {
    const backend = (await signalCli.load())(env);
    expect(backend.kind).toBe('signal-cli');
    expect(platform.loaded).toBe(0);
    expect(platform.transports).toHaveLength(0);
  });

  it('uses the Tauri transport, with the desktop settings, inside the desktop app', async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    (await signalCli.load())(env);
    expect(platform.loaded).toBe(1);
    expect(platform.transports).toEqual([{ desktop }]);
  });
});

describe('installFlushBeforeClose', () => {
  it('never loads the desktop platform in the browser', () => {
    installFlushBeforeClose(() => Promise.resolve());
    expect(platform.flushHandlers).toHaveLength(0);
  });

  it('registers the handler with the desktop close handshake inside Tauri', async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const handler = () => Promise.resolve();
    installFlushBeforeClose(handler);
    await vi.waitFor(() => {
      expect(platform.flushHandlers).toContain(handler);
    });
  });
});

describe('desktopLogAdmin', () => {
  // `createSnowdrop` only constructs this when `isTauri()` (`logs: isTauri()
  // ? desktopLogAdmin() : null`, matching `desktopAdmin`/`desktopStorageAdmin`
  // just above) — the admin itself calls through unconditionally, same as
  // those.
  it('calls through to the Tauri log commands', async () => {
    const admin = desktopLogAdmin();
    await expect(admin.recent(2048)).resolves.toBe('desktop log tail');
    await admin.setVerbose(true);
    expect(platform.logSetVerbose).toHaveBeenCalledWith(true);
    admin.openFolder();
    await vi.waitFor(() => {
      expect(platform.logOpenFolder).toHaveBeenCalledTimes(1);
    });
    // `setVerbose(true)` above also sets platform.ts's own gating flag;
    // reset it so it doesn't leak into the sink tests below.
    await admin.setVerbose(false);
  });
});

describe('installTerminalErrorLog (desktop log sink)', () => {
  it('forwards warn/error to the desktop log always, info/debug only once verbose logging is on', async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    installTerminalErrorLog();
    const log = createLogger('platform-sink-test');

    log.error('e1');
    log.warn('w1');
    log.info('i1');
    log.debug('d1');
    await vi.waitFor(() => {
      expect(platform.sentLogs.some((l) => l.message === 'e1')).toBe(true);
    });
    expect(platform.sentLogs.some((l) => l.message === 'w1')).toBe(true);
    expect(platform.sentLogs.some((l) => l.message === 'i1')).toBe(false);
    expect(platform.sentLogs.some((l) => l.message === 'd1')).toBe(false);

    await desktopLogAdmin().setVerbose(true);
    log.info('i2');
    log.debug('d2');
    await vi.waitFor(() => {
      expect(platform.sentLogs.some((l) => l.message === 'i2')).toBe(true);
    });
    expect(platform.sentLogs.some((l) => l.message === 'd2')).toBe(true);

    // Reset the gating flag for any later test in this file.
    await desktopLogAdmin().setVerbose(false);
  });

  it('logs an uncaught window error at scope app', async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    installTerminalErrorLog();
    const error = new Error('uncaught boom');
    window.dispatchEvent(Object.assign(new Event('error'), { error }));
    await vi.waitFor(() => {
      expect(
        platform.sentLogs.some((l) => l.scope === 'app' && l.message.includes('uncaught')),
      ).toBe(true);
    });
  });
});
