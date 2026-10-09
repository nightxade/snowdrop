import { describe, expect, it, vi } from 'vitest';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { tauriNotificationApi } from './notifications';
import type { TauriIpc } from './ipc';

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve('granted'),
  sendNotification: vi.fn(),
}));
vi.mock('./ipc', () => ({ tauriIpc: {} }));

function setup() {
  const invoke = vi.fn().mockResolvedValue(true);
  const ipc: TauriIpc = { invoke, listen: vi.fn() };
  return { invoke, ipc };
}
const content = { tag: 'snowdrop:ana', title: 'Ana', body: 'hello' };
const clicked = () => undefined;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('native notifications', () => {
  it('reuses a conversation tag without withdrawing its previous notification', async () => {
    const { invoke, ipc } = setup();
    const api = await tauriNotificationApi(ipc);
    const first = api.show(content, clicked)!;
    await flush();
    first.close();
    api.show({ ...content, body: 'newest' }, clicked);
    await flush();
    expect(invoke.mock.calls).toEqual([
      ['notification_show', content],
      ['notification_show', { ...content, body: 'newest' }],
    ]);
  });

  it('coalesces a burst and keeps different conversations separate', async () => {
    const { invoke, ipc } = setup();
    const api = await tauriNotificationApi(ipc);
    const first = api.show(content, clicked)!;
    first.close();
    api.show({ ...content, body: 'newest' }, clicked);
    api.show({ ...content, tag: 'snowdrop:bo' }, clicked);
    await flush();
    expect(invoke.mock.calls).toEqual([
      ['notification_show', { ...content, body: 'newest' }],
      ['notification_show', { ...content, tag: 'snowdrop:bo' }],
    ]);
  });

  it('withdraws the current notification and ignores an obsolete handle', async () => {
    const { invoke, ipc } = setup();
    const api = await tauriNotificationApi(ipc);
    const old = api.show(content, clicked)!;
    const latest = api.show(content, clicked)!;
    await flush();
    old.close();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    latest.close();
    await flush();
    expect(invoke).toHaveBeenLastCalledWith('notification_close', { tag: content.tag });
  });

  it('serializes slow sends and recovers after a failed request', async () => {
    const { invoke, ipc } = setup();
    let finish!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => { resolve(true); };
        }),
    );
    const api = await tauriNotificationApi(ipc);
    api.show(content, clicked);
    await flush();
    api.show({ ...content, body: 'second' }, clicked);
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    invoke.mockRejectedValueOnce(new Error('service unavailable'));
    api.show(content, clicked);
    await flush();
    api.show({ ...content, body: 'recovered' }, clicked);
    await flush();
    expect(invoke).toHaveBeenLastCalledWith('notification_show', { ...content, body: 'recovered' });
  });

  it('uses the plugin on platforms without the native bridge', async () => {
    const { invoke, ipc } = setup();
    invoke.mockResolvedValue(false);
    const api = await tauriNotificationApi(ipc);
    api.show(content, clicked);
    await flush();
    expect(sendNotification).toHaveBeenCalledWith({ title: content.title, body: content.body });
  });
});
