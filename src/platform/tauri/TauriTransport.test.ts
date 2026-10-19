/**
 * The desktop transport with `@tauri-apps/api` mocked: the commands it calls,
 * how Rust errors and stream states map onto the adapter's, and the order
 * of listen → subscribe (held events are replayed during subscribe).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type SignalCliError } from '@/core/backend/signal-cli';
import { DEFAULT_DESKTOP_CONNECTION, type DesktopConnection } from '@/core/stores';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  order: [] as string[],
  notifications: {
    granted: false,
    sent: [] as unknown[],
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => {
    ipc.order.push(`invoke:${command}`);
    return ipc.invoke(command, args);
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    ipc.order.push(`listen:${event}`);
    const set = ipc.listeners.get(event) ?? new Set();
    set.add(handler);
    ipc.listeners.set(event, set);
    return Promise.resolve(() => set.delete(handler));
  },
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => Promise.resolve(ipc.notifications.granted),
  requestPermission: () => Promise.resolve('granted'),
  sendNotification: (options: unknown) => ipc.notifications.sent.push(options),
}));

const { TauriTransport, createDesktopAdmin, installExternalLinks, tauriNotificationApi } =
  await import('./index');

function emit(event: string, payload: unknown): void {
  for (const handler of ipc.listeners.get(event) ?? []) handler({ payload });
}

const call = { signal: new AbortController().signal, timeoutMs: 5_000 };
const spawn: DesktopConnection = { ...DEFAULT_DESKTOP_CONNECTION, binaryPath: ' /opt/signal-cli ' };

beforeEach(() => {
  ipc.invoke.mockReset();
  ipc.listeners.clear();
  ipc.order.length = 0;
});

describe('TauriTransport', () => {
  it('connects with the configuration the Rust side expects', async () => {
    ipc.invoke.mockResolvedValue({ mode: 'spawn', run: 'r1' });
    await new TauriTransport({ desktop: spawn }).check(call);
    expect(ipc.invoke).toHaveBeenCalledWith('signal_cli_connect', {
      config: { mode: 'spawn', binaryPath: '/opt/signal-cli', account: null },
    });
    await new TauriTransport({
      desktop: { ...spawn, mode: 'external', externalUrl: 'http://127.0.0.1:8080 ' },
    }).check(call);
    expect(ipc.invoke).toHaveBeenLastCalledWith('signal_cli_connect', {
      config: { mode: 'external', url: 'http://127.0.0.1:8080' },
    });
  });

  it('restarts with the same configuration, and maps a failure like any other command', async () => {
    ipc.invoke.mockResolvedValueOnce({ mode: 'spawn', run: 'r2' });
    await new TauriTransport({ desktop: spawn }).restart();
    expect(ipc.invoke).toHaveBeenCalledWith('signal_cli_restart', {
      config: { mode: 'spawn', binaryPath: '/opt/signal-cli', account: null },
    });
    ipc.invoke.mockRejectedValueOnce({ kind: 'not-installed', message: 'Install signal-cli…' });
    await expect(new TauriTransport({ desktop: spawn }).restart()).rejects.toMatchObject({
      name: 'SignalCliError',
      kind: 'not-installed',
    });
  });

  it('scopes resume cursors by mode', () => {
    expect(new TauriTransport({ desktop: spawn }).resumeScope).toBe('desktop');
    expect(new TauriTransport({ desktop: { ...spawn, mode: 'external' } }).resumeScope).toBe(
      'desktop-external',
    );
  });

  it('passes requests through and returns the JSON-RPC reply', async () => {
    ipc.invoke.mockResolvedValue({ result: [] });
    const reply = await new TauriTransport({ desktop: spawn }).request(
      'listGroups',
      { account: '+1' },
      call,
    );
    expect(reply).toEqual({ result: [] });
    expect(ipc.invoke).toHaveBeenCalledWith('signal_cli_request', {
      method: 'listGroups',
      params: { account: '+1' },
      timeoutMs: 5_000,
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a non-object', 'nope'],
    ['an object with neither result nor error', { id: 1 }],
    ['an error without a code/message', { error: { oops: true } }],
  ] as const)(
    'turns a malformed IPC reply (%s) into an invalid-response error',
    async (_label, raw) => {
      ipc.invoke.mockResolvedValue(raw);
      await expect(
        new TauriTransport({ desktop: spawn }).request('listGroups', undefined, call),
      ).rejects.toMatchObject({ name: 'SignalCliError', kind: 'invalid-response' });
    },
  );

  it('maps command errors onto SignalCliError kinds', async () => {
    const transport = new TauriTransport({ desktop: spawn });
    ipc.invoke.mockRejectedValueOnce({ kind: 'not-installed', message: 'Install signal-cli…' });
    await expect(transport.check(call)).rejects.toMatchObject({
      name: 'SignalCliError',
      kind: 'not-installed',
      message: 'Install signal-cli…',
    });
    ipc.invoke.mockRejectedValueOnce('a plain string');
    await expect(transport.request('x', undefined, call)).rejects.toMatchObject({
      kind: 'internal',
      message: 'a plain string',
    });
  });

  it('listens before subscribing, forwards events and maps stream states', async () => {
    const events: unknown[] = [];
    const states: unknown[] = [];
    ipc.invoke.mockImplementation((command) => {
      // The Rust side replays a held event while subscribing.
      if (command === 'signal_cli_subscribe')
        emit('signal-cli://event', { cursor: 'r1:3', type: 'receive', data: { envelope: {} } });
      return Promise.resolve('r1');
    });
    const sub = new TauriTransport({ desktop: spawn }).subscribe({
      account: '+15550001',
      resumeFrom: 'r1:2',
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
    });
    sub.start();
    await vi.waitFor(() => {
      expect(states).toContainEqual({ kind: 'open' });
    });
    expect(ipc.order).toEqual([
      'listen:signal-cli://event',
      'listen:signal-cli://state',
      'invoke:signal_cli_subscribe',
    ]);
    expect(ipc.invoke).toHaveBeenCalledWith('signal_cli_subscribe', {
      account: '+15550001',
      resumeFrom: 'r1:2',
    });
    expect(events).toEqual([{ type: 'receive', data: { envelope: {} }, cursor: 'r1:3' }]);

    emit('signal-cli://state', { kind: 'waiting', attempt: 1, delayMs: 2000, reason: 'exited' });
    emit('signal-cli://state', { kind: 'failed', errorKind: 'not-installed', message: 'gone' });
    const waiting = states.at(-2) as { kind: string; delayMs: number; error: SignalCliError };
    expect(waiting).toMatchObject({ kind: 'waiting', attempt: 1, delayMs: 2000 });
    expect(waiting.error.message).toBe('exited');
    expect(states.at(-1)).toMatchObject({ kind: 'failed', error: { kind: 'not-installed' } });

    await sub.stop();
    expect(states.at(-1)).toEqual({ kind: 'closed' });
    expect(ipc.listeners.get('signal-cli://event')?.size).toBe(0);
    emit('signal-cli://event', { cursor: 'r1:4', type: 'receive', data: {} });
    expect(events).toHaveLength(1);
  });

  it('does not flicker back to open if stop() races an in-flight signal_cli_subscribe', async () => {
    const states: { kind: string }[] = [];
    let resolveSubscribe: (() => void) | undefined;
    ipc.invoke.mockImplementation((command) => {
      if (command === 'signal_cli_subscribe') {
        return new Promise<string>((resolve) => {
          resolveSubscribe = () => {
            resolve('r1');
          };
        });
      }
      return Promise.resolve('r1');
    });
    const sub = new TauriTransport({ desktop: spawn }).subscribe({
      account: null,
      resumeFrom: '',
      onEvent: () => undefined,
      onState: (s) => states.push(s),
    });
    sub.start();
    await vi.waitFor(() => {
      expect(states).toContainEqual({ kind: 'connecting', attempt: 0 });
    });

    // stop() while signal_cli_subscribe is still in flight...
    const stopped = sub.stop();
    // ...then the call finally succeeds.
    resolveSubscribe?.();
    await stopped;

    // `closed` is the last word: the late success never flickers it back to `open`.
    expect(states.map((s) => s.kind)).toEqual(['connecting', 'closed']);
  });

  it('retries a subscription while signal-cli is restarting, and gives up when it is missing', async () => {
    const states: { kind: string }[] = [];
    ipc.invoke
      .mockRejectedValueOnce({ kind: 'unreachable', message: 'restarting' })
      .mockResolvedValueOnce('r1');
    const sub = new TauriTransport({ desktop: spawn, retryDelaysMs: [1] }).subscribe({
      account: null,
      resumeFrom: '',
      onEvent: () => undefined,
      onState: (s) => states.push(s),
    });
    sub.start();
    await vi.waitFor(() => {
      expect(states.at(-1)).toEqual({ kind: 'open' });
    });
    expect(states.map((s) => s.kind)).toEqual(['connecting', 'waiting', 'connecting', 'open']);
    await sub.stop();

    states.length = 0;
    ipc.invoke.mockRejectedValueOnce({ kind: 'not-installed', message: 'no signal-cli' });
    const missing = new TauriTransport({ desktop: spawn }).subscribe({
      account: null,
      resumeFrom: '',
      onEvent: () => undefined,
      onState: (s) => states.push(s),
    });
    missing.start();
    await vi.waitFor(() => {
      expect(states.at(-1)?.kind).toBe('failed');
    });
    expect(ipc.invoke).toHaveBeenCalledTimes(3);
  });

  it('acknowledges cursors without failing the caller', async () => {
    ipc.invoke.mockRejectedValue(new Error('window closing'));
    new TauriTransport({ desktop: spawn }).acknowledge('r1:9');
    expect(ipc.invoke).toHaveBeenCalledWith('signal_cli_ack', { cursor: 'r1:9' });
    await Promise.resolve();
  });
});

describe('desktop admin', () => {
  it('probes, locates and reads build info through commands', async () => {
    const admin = createDesktopAdmin();
    ipc.invoke.mockResolvedValueOnce({
      accounts: 1,
      version: '0.14.8',
      binary: { path: '/app/signal-cli', source: 'bundled' },
    });
    expect(await admin.probe(DEFAULT_DESKTOP_CONNECTION)).toEqual({
      ok: true,
      accounts: 1,
      version: '0.14.8',
      program: { path: '/app/signal-cli', source: 'bundled' },
    });
    ipc.invoke.mockRejectedValueOnce({ kind: 'config', message: 'must be absolute' });
    expect(await admin.locate({ binaryPath: 'signal-cli' })).toEqual({
      ok: false,
      kind: 'config',
      message: 'must be absolute',
    });
    expect(ipc.invoke).toHaveBeenLastCalledWith('signal_cli_locate', {
      binaryPath: 'signal-cli',
    });
    ipc.invoke.mockResolvedValueOnce({
      managedSignalCli: '0.14.8',
      dataDir: '/d',
      trayAvailable: true,
    });
    await admin.info();
    await admin.info();
    expect(ipc.invoke.mock.calls.filter(([c]) => c === 'desktop_info')).toHaveLength(1);
  });

  it('turns a malformed probe/locate reply into a typed invalid-response error', async () => {
    const admin = createDesktopAdmin();
    ipc.invoke.mockResolvedValueOnce(undefined);
    expect(await admin.probe(DEFAULT_DESKTOP_CONNECTION)).toMatchObject({
      ok: false,
      kind: 'invalid-response',
    });
    ipc.invoke.mockResolvedValueOnce({ accounts: 1, version: '0.14.8', binary: { path: '/x' } });
    expect(await admin.probe(DEFAULT_DESKTOP_CONNECTION)).toMatchObject({
      ok: false,
      kind: 'invalid-response',
    });
    ipc.invoke.mockResolvedValueOnce('not an object');
    expect(await admin.locate({ binaryPath: '' })).toMatchObject({
      ok: false,
      kind: 'invalid-response',
    });
  });

  it('falls back to defaults when desktop_info resolves something unexpected', async () => {
    const admin = createDesktopAdmin();
    ipc.invoke.mockResolvedValueOnce(null);
    expect(await admin.info()).toEqual({
      managedSignalCli: null,
      signalCliReleaseUrl: null,
      signalCliLicense: null,
      signalCliSource: null,
      dataDir: '',
      logFile: null,
      trayAvailable: false,
    });
  });

  it('rejects a malformed install status/pinned release reply', async () => {
    const admin = createDesktopAdmin();
    ipc.invoke.mockResolvedValueOnce({ installed: 'yes' });
    await expect(admin.installStatus()).rejects.toMatchObject({ kind: 'invalid-response' });
    ipc.invoke.mockResolvedValueOnce({ version: '1.0' });
    await expect(admin.pinnedRelease()).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('external links', () => {
  it('opens web links in the system browser instead of navigating', () => {
    ipc.invoke.mockResolvedValue(undefined);
    const off = installExternalLinks(document);
    const link = document.createElement('a');
    link.href = 'https://example.org/page';
    link.textContent = 'x';
    const local = document.createElement('a');
    local.href = '#settings';
    document.body.append(link, local);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(ipc.invoke).toHaveBeenCalledWith('open_external', { url: 'https://example.org/page' });
    const inApp = new MouseEvent('click', { bubbles: true, cancelable: true });
    local.dispatchEvent(inApp);
    expect(inApp.defaultPrevented).toBe(false);
    off();
    link.remove();
    local.remove();
  });
});

describe('native notifications', () => {
  it('asks for permission once, then shows notifications through the plugin', async () => {
    ipc.invoke.mockResolvedValue(false); // Platform without the Linux replacement bridge.
    ipc.notifications.granted = false;
    ipc.notifications.sent.length = 0;
    const api = await tauriNotificationApi();
    expect(api.permission()).toBe('default');
    expect(api.show({ title: 'Ada', body: 'hi', tag: 'c1' }, () => undefined)).toBeNull();
    expect(await api.request()).toBe('granted');
    expect(api.show({ title: 'Ada', body: 'hi', tag: 'c1' }, () => undefined)).not.toBeNull();
    await vi.waitFor(() => {
      expect(ipc.notifications.sent).toEqual([{ title: 'Ada', body: 'hi' }]);
    });
  });
});
