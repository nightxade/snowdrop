import { describe, expect, it, vi } from 'vitest';
import { createStores } from '@/core/stores';
import { Registries } from './registries';
import { PluginRuntime } from './runtime';
import { definePlugin, type PluginHost } from './types';

function host(): PluginHost {
  return {
    stores: createStores(),
    toast: vi.fn(),
    onError: vi.fn(),
    backend: {
      kind: 'mock',
      status: () => 'online',
      sendText: vi.fn(() => Promise.resolve()),
      onMessage: () => () => undefined,
    },
  };
}

describe('plugin runtime enable/retry (M5)', () => {
  it('starts a plugin once per toggle and never touches the others', async () => {
    const startA = vi.fn();
    let failB = true;
    const startB = vi.fn(() => {
      if (failB) throw new Error('B is broken');
    });
    const a = definePlugin({ id: 'a', name: 'A', description: '', authors: [], start: startA });
    const b = definePlugin({
      id: 'b',
      name: 'B',
      description: '',
      authors: [],
      enabledByDefault: true,
      start: startB,
    });
    const runtime = new PluginRuntime(host(), new Registries(() => undefined), [a, b]);
    await runtime.startAll();
    expect(runtime.get('b')?.status).toBe('failed');
    expect(startB).toHaveBeenCalledTimes(1);

    await runtime.setEnabled('a', true);
    expect(startA).toHaveBeenCalledTimes(1);
    await runtime.setEnabled('a', false);
    await runtime.setEnabled('a', true);
    expect(startA).toHaveBeenCalledTimes(2);
    // Toggling A never retried the failed B.
    expect(startB).toHaveBeenCalledTimes(1);
    expect(runtime.get('b')?.status).toBe('failed');

    failB = false;
    await runtime.retry('b');
    expect(startB).toHaveBeenCalledTimes(2);
    expect(runtime.get('b')?.status).toBe('running');
  });

  it('applies setEnabled before startAll too', async () => {
    const start = vi.fn();
    const p = definePlugin({ id: 'p', name: 'P', description: '', authors: [], start });
    const runtime = new PluginRuntime(host(), new Registries(() => undefined), [p]);
    await runtime.setEnabled('p', true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(runtime.get('p')?.status).toBe('running');
  });

  it('retry does nothing for a disabled plugin', async () => {
    const start = vi.fn();
    const p = definePlugin({ id: 'p', name: 'P', description: '', authors: [], start });
    const runtime = new PluginRuntime(host(), new Registries(() => undefined), [p]);
    await runtime.startAll();
    await runtime.retry('p');
    expect(start).not.toHaveBeenCalled();
  });
});
