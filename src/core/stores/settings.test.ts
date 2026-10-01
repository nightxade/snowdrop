import { describe, expect, it } from 'vitest';
import { createMemoryStorage, loadVersioned } from '@/core/persistence';
import { createSettingsStore, defaultSettings, parseSettings, settingsSchema } from './settings';

describe('settingsStore', () => {
  it('updates sections immutably', () => {
    const store = createSettingsStore();
    const before = store.getState().behaviour;
    store.getState().update('appearance', { density: 'compact' });
    expect(store.getState().appearance.density).toBe('compact');
    expect(store.getState().behaviour).toBe(before);
  });

  it('manages plugin entries and keybinds', () => {
    const store = createSettingsStore();
    store.getState().setPluginSetting('p', 'x', 1);
    // Changing a setting must not decide enablement (the plugin default still applies).
    expect(store.getState().plugins.p).toEqual({ settings: { x: 1 } });
    store.getState().setPluginEnabled('p', true);
    expect(store.getState().plugins.p).toEqual({ enabled: true, settings: { x: 1 } });
    store.getState().setKeybind('switcher.open', 'Mod+P');
    store.getState().setKeybind('switcher.open', null);
    expect(store.getState().keybinds).toEqual({});
  });

  it('parses field-by-field, clamping and falling back per field', () => {
    const parsed = parseSettings({
      appearance: {
        themeId: 'linen',
        accent: 'red',
        fontScale: 9,
        density: 'huge',
        clock24h: false,
      },
      behaviour: 'nope',
      plugins: { a: { enabled: true, settings: { k: 'v' } }, b: 3, c: { enabled: 'yes' } },
      keybinds: { x: 'Mod+X', y: 2 },
    });
    const d = defaultSettings();
    expect(parsed.appearance).toEqual({
      ...d.appearance,
      themeId: 'linen',
      fontScale: 1.25,
      clock24h: false,
    });
    expect(parsed.behaviour).toEqual(d.behaviour);
    expect(parsed.plugins).toEqual({
      a: { enabled: true, settings: { k: 'v' } },
      c: { settings: {} },
    });
    expect(parsed.keybinds).toEqual({ x: 'Mod+X' });
    expect(parseSettings(null)).toEqual(d);
  });

  it('migrates v1 connection settings (account, proxy URL) and keeps custom URLs', () => {
    const v1 = (daemonUrl: string) =>
      createMemoryStorage({
        'shrike.settings': JSON.stringify({
          v: 1,
          data: { connection: { backend: 'signal-cli', daemonUrl, mockLiveliness: false } },
        }),
      });
    expect(loadVersioned(v1('http://127.0.0.1:8080'), settingsSchema).connection).toEqual({
      backend: 'signal-cli',
      daemonUrl: '/signal-cli',
      account: null,
      mockLiveliness: false,
    });
    expect(loadVersioned(v1('http://10.0.0.2:9000'), settingsSchema).connection.daemonUrl).toBe(
      'http://10.0.0.2:9000',
    );
    expect(
      parseSettings({ connection: { account: '+15550000000', daemonUrl: '  ' } }).connection,
    ).toMatchObject({ account: '+15550000000', daemonUrl: '/signal-cli' });
  });
});
