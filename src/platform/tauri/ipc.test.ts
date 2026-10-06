/**
 * `tauriIpc.invoke` against a mocked `@tauri-apps/api/core`: it times every
 * command, logs a `perf` warning past 200ms naming only the command (never
 * its args or result), and exposes the most recently started command for
 * the stall detector (`src/app/perf.ts`).
 */
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const core = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => core.invoke(command, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

describe('tauriIpc.invoke', () => {
  let warnSpy: MockInstance<(...args: unknown[]) => void>;
  let time: number;

  beforeEach(() => {
    vi.resetModules();
    core.invoke.mockReset();
    time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it("resolves with the command's result", async () => {
    core.invoke.mockResolvedValue({ ok: true });
    const { tauriIpc } = await import('./ipc');
    await expect(tauriIpc.invoke('storage_status')).resolves.toEqual({ ok: true });
  });

  it('logs a slow-IPC warning past 200ms, naming only the command', async () => {
    core.invoke.mockImplementation(() => {
      time += 250;
      return Promise.resolve('secret-result');
    });
    const { tauriIpc } = await import('./ipc');
    await tauriIpc.invoke('storage_unlock', { secret: 'hunter2' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [line] = warnSpy.mock.calls[0] as [string];
    expect(line).toContain('slow IPC storage_unlock 250 ms');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('secret-result');
  });

  it('does not warn under the threshold', async () => {
    core.invoke.mockImplementation(() => {
      time += 50;
      return Promise.resolve(null);
    });
    const { tauriIpc } = await import('./ipc');
    await tauriIpc.invoke('signal_cli_ack');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still times and reports a rejected command', async () => {
    core.invoke.mockImplementation(() => {
      time += 300;
      return Promise.reject(new Error('boom'));
    });
    const { tauriIpc } = await import('./ipc');
    await expect(tauriIpc.invoke('storage_setup')).rejects.toThrow('boom');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [line] = warnSpy.mock.calls[0] as [string];
    expect(line).toContain('slow IPC storage_setup 300 ms');
  });

  it('exposes the most recently started command for the stall detector', async () => {
    let resolveInvoke: (() => void) | undefined;
    core.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = () => {
            resolve(null);
          };
        }),
    );
    const { tauriIpc, getLastIpcCommand } = await import('./ipc');
    expect(getLastIpcCommand()).toBeNull();
    const startedAt = time;
    const pending = tauriIpc.invoke('desktop_info');
    expect(getLastIpcCommand()).toEqual({ command: 'desktop_info', startedAt });
    resolveInvoke?.();
    await pending;
  });
});
