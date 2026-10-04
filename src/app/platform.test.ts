/**
 * The transport choice in the backend registry: the browser (and every
 * other test) never loads the desktop platform layer; inside Tauri the
 * signal-cli backend gets the IPC transport with the desktop settings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { DEFAULT_DESKTOP_CONNECTION, type DesktopConnection } from '@/core/stores';
import { BUILTIN_BACKENDS, type BackendEnvironment } from './backends';
import { installFlushBeforeClose } from './platform';

const platform = vi.hoisted(() => ({
  loaded: 0,
  transports: [] as unknown[],
  flushHandlers: [] as (() => Promise<void>)[],
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
