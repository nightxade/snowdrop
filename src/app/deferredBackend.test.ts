import { describe, expect, it, vi } from 'vitest';
import type { ChatBackend } from '@/core/backend';
import { MockBackend } from '@/core/backend/mock';
import { SignalCliBackend } from '@/core/backend/signal-cli';
import { ManualScheduler } from '@/core/lib';
import { BACKEND_CAPABILITIES, deferredBackend, OPTIONAL_METHODS } from './deferredBackend';

const present = (b: ChatBackend) =>
  OPTIONAL_METHODS.filter((m) => (b as unknown as Record<string, unknown>)[m] !== undefined).sort();

describe('deferredBackend', () => {
  it('declares exactly the optional methods each real adapter has', () => {
    const mock = new MockBackend({ latencyMs: 0 });
    const cli = new SignalCliBackend({ baseUrl: '/signal-cli', account: null });
    expect([...BACKEND_CAPABILITIES.mock].sort()).toEqual(present(mock));
    expect([...BACKEND_CAPABILITIES['signal-cli']].sort()).toEqual(present(cli));
  });

  it('exposes capabilities before the adapter loads and forwards calls after', async () => {
    let resolve!: (b: ChatBackend) => void;
    const ready = new Promise<ChatBackend>((r) => {
      resolve = r;
    });
    const deferred = deferredBackend('mock', ready);
    expect(deferred.kind).toBe('mock');
    expect('fetchHistory' in deferred).toBe(true);
    expect('resolveAttachmentUrl' in deferred).toBe(false);
    expect(deferred.getStatus()).toBe('offline');

    // Subscriptions made early are attached on load; unsubscribing early works too.
    const early = vi.fn();
    const dropped = vi.fn();
    deferred.on('status', early);
    const off = deferred.on('status', dropped);
    off();

    const real = new MockBackend({ latencyMs: 0, scheduler: new ManualScheduler() });
    const connecting = deferred.connect();
    resolve(real);
    await connecting;
    expect(deferred.getStatus()).toBe(real.getStatus());
    expect(early).toHaveBeenCalled();
    expect(dropped).not.toHaveBeenCalled();
  });

  it('rejects calls when the adapter fails to load', async () => {
    const deferred = deferredBackend('signal-cli', Promise.reject(new Error('chunk failed')));
    await expect(deferred.connect()).rejects.toThrow('chunk failed');
    expect(deferred.link).toBeDefined();
  });
});
