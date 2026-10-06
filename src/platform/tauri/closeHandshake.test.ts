/**
 * `onFlushBeforeClose` against a fake `TauriIpc` — no `@tauri-apps/api`
 * mocking needed since it takes `ipc` as a parameter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENT_FLUSH_BEFORE_CLOSE, onFlushBeforeClose } from './closeHandshake';
import type { TauriIpc } from './ipc';

function fakeIpc(): {
  ipc: TauriIpc;
  invoke: ReturnType<typeof vi.fn>;
  emit: () => void;
} {
  let handler: ((payload: unknown) => void) | null = null;
  const invoke = vi.fn().mockResolvedValue(undefined);
  const ipc: TauriIpc = {
    invoke,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    listen: <T>(event: string, h: (payload: T) => void) => {
      if (event === EVENT_FLUSH_BEFORE_CLOSE) handler = h as (payload: unknown) => void;
      return Promise.resolve(() => {
        handler = null;
      });
    },
  };
  return { ipc, invoke, emit: () => handler?.(undefined) };
}

describe('onFlushBeforeClose', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs the handler, then answers app_close_ready', async () => {
    const { ipc, invoke, emit } = fakeIpc();
    const handler = vi.fn().mockResolvedValue(undefined);
    await onFlushBeforeClose(handler, ipc);

    emit();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('app_close_ready');
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('still answers app_close_ready when the handler throws', async () => {
    const { ipc, invoke, emit } = fakeIpc();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await onFlushBeforeClose(() => Promise.reject(new Error('boom')), ipc);

    emit();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('app_close_ready');
    });
    expect(warn).toHaveBeenCalled();
  });

  it('answers app_close_ready after its own timeout, even if the handler never settles', async () => {
    vi.useFakeTimers();
    const { ipc, invoke, emit } = fakeIpc();
    await onFlushBeforeClose(() => new Promise<void>(() => {}), ipc);

    emit();
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invoke).toHaveBeenCalledWith('app_close_ready');
  });

  it('registers under the documented event name', async () => {
    let seen: string | null = null;
    const ipc: TauriIpc = {
      invoke: vi.fn().mockResolvedValue(undefined),
      listen: (event) => {
        seen = event;
        return Promise.resolve(() => {});
      },
    };
    await onFlushBeforeClose(() => Promise.resolve(), ipc);
    expect(seen).toBe('snowdrop://flush-before-close');
    expect(seen).toBe(EVENT_FLUSH_BEFORE_CLOSE);
  });
});
