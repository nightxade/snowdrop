import { describe, expect, it, vi } from 'vitest';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { EVENT_NOTIFICATION_CLICKED, tauriNotificationApi } from './notifications';
import type { TauriIpc } from './ipc';

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve('granted'),
  sendNotification: vi.fn(),
}));
vi.mock('./ipc', () => ({ tauriIpc: {} }));

/** A fake `ipc.listen` that remembers handlers so a test can fire them,
 * same shape the real Tauri `listen` resolves to (an unlisten function). */
function fakeIpc() {
  const invoke = vi.fn().mockResolvedValue(true);
  const handlers = new Map<string, (payload: unknown) => void>();
  const listen = vi.fn((event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
    return Promise.resolve(() => handlers.delete(event));
  });
  const ipc: TauriIpc = { invoke, listen };
  const fire = (event: string, payload: unknown) => handlers.get(event)?.(payload);
  return { invoke, ipc, fire };
}

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
          finish = () => {
            resolve(true);
          };
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

  it("runs the right conversation's onClick when Rust reports a click", async () => {
    const { ipc, fire } = fakeIpc();
    const api = await tauriNotificationApi(ipc);
    const anaClicked = vi.fn();
    const boClicked = vi.fn();
    api.show(content, anaClicked);
    api.show({ ...content, tag: 'snowdrop:bo' }, boClicked);
    await flush();
    fire(EVENT_NOTIFICATION_CLICKED, 'snowdrop:bo');
    expect(boClicked).toHaveBeenCalledTimes(1);
    expect(anaClicked).not.toHaveBeenCalled();
  });

  it('ignores a click reported for a tag that was already closed', async () => {
    const { ipc, fire } = fakeIpc();
    const api = await tauriNotificationApi(ipc);
    const onClick = vi.fn();
    const shown = api.show(content, onClick)!;
    await flush();
    shown.close();
    await flush();
    fire(EVENT_NOTIFICATION_CLICKED, content.tag);
    expect(onClick).not.toHaveBeenCalled();
  });
});
