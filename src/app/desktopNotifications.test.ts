/** The desktop notification API: its permission is "default" until the plugin answers, and it says when that changes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationApi, NotificationPermissionState } from '@/core/services';

const plugin = vi.hoisted(() => ({
  load: (): Promise<unknown> => Promise.resolve(),
}));

vi.mock('@/platform/tauri', () => ({ tauriNotificationApi: () => plugin.load() }));

import { desktopNotificationApi } from './platform';

function nativeApi(initial: NotificationPermissionState): NotificationApi {
  let permission = initial;
  return {
    permission: () => permission,
    request: () => {
      permission = 'granted';
      return Promise.resolve(permission);
    },
    show: () => null,
  };
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
};

beforeEach(() => {
  plugin.load = () => Promise.resolve(nativeApi('granted'));
});

describe('desktopNotificationApi', () => {
  it('reads "default" until the plugin has loaded, tells subscribers, then reports its answer', async () => {
    let release: (api: NotificationApi) => void = () => undefined;
    plugin.load = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const api = desktopNotificationApi();
    const changed = vi.fn();
    api.subscribe?.(changed);
    await flush();
    expect(api.permission()).toBe('default');
    expect(changed).not.toHaveBeenCalled();
    release(nativeApi('granted'));
    await flush();
    expect(api.permission()).toBe('granted');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('reads "unsupported" and tells subscribers when the plugin cannot load', async () => {
    plugin.load = () => Promise.reject(new Error('no plugin'));
    const api = desktopNotificationApi();
    const changed = vi.fn();
    api.subscribe?.(changed);
    await flush();
    expect(api.permission()).toBe('unsupported');
    expect(changed).toHaveBeenCalled();
    expect(await api.request()).toBe('unsupported');
  });

  it('tells subscribers after a request, and not after they unsubscribe', async () => {
    plugin.load = () => Promise.resolve(nativeApi('default'));
    const api = desktopNotificationApi();
    await flush();
    const changed = vi.fn();
    const stop = api.subscribe?.(changed);
    expect(await api.request()).toBe('granted');
    expect(changed).toHaveBeenCalledTimes(1);
    stop?.();
    await api.request();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
