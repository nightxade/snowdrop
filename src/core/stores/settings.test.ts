import { describe, expect, it } from 'vitest';
import { createSettingsStore, defaultSettings, parseSettings } from './settings';

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
});
