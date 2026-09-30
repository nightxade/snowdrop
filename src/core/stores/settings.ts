/**
 * User settings, persisted and versioned.
 *
 * Every section is parsed field-by-field against its defaults on load, so a
 * corrupted or partially-written value degrades to the default for *that
 * field* instead of resetting everything.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { isRecord, type VersionedSchema } from '@/core/persistence';

export type Density = 'cozy' | 'compact';
export type ReducedMotion = 'system' | 'on' | 'off';
export type NotificationMode = 'all' | 'mentions' | 'none';
export type BackendChoice = 'mock' | 'signal-cli';

export interface AppearanceSettings {
  themeId: string;
  /** Hex accent override, or null for the theme's own accent. */
  accent: string | null;
  density: Density;
  /** 0.875–1.25 */
  fontScale: number;
  /** 0.8–1.5 */
  zoom: number;
  /** 0–1 */
  saturation: number;
  reducedMotion: ReducedMotion;
  showAvatarsInCompact: boolean;
  clock24h: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  mode: NotificationMode;
  sound: boolean;
  showPreview: boolean;
}

export interface BehaviourSettings {
  /** Enter sends, Shift+Enter inserts a newline (false swaps them). */
  enterToSend: boolean;
  sendTypingIndicators: boolean;
  sendReadReceipts: boolean;
  /** Convert markdown to native Signal formatting on send. */
  markdown: boolean;
  /** Off by default: fetching previews leaks what you're reading to third parties. */
  linkPreviews: boolean;
}

export interface ConnectionSettings {
  /** Chosen on the welcome screen; null until the user picks. */
  backend: BackendChoice | null;
  /**
   * Base URL the *browser* uses to reach signal-cli. The default is the
   * same-origin Vite proxy path (`/signal-cli` → HEARTH_SIGNAL_CLI_URL,
   * default http://127.0.0.1:8080), because the daemon sends no CORS headers
   * and pins the Host header. An absolute URL only works same-origin.
   */
  daemonUrl: string;
  /** signal-cli account (ACI or number) in multi-account mode; null = the only/first one. */
  account: string | null;
  /** Mock only: simulated activity. */
  mockLiveliness: boolean;
}

export interface PluginEntry {
  /** Absent until the user toggles the plugin, so the plugin's own default applies. */
  enabled?: boolean;
  settings: Record<string, unknown>;
}

export interface Settings {
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
  behaviour: BehaviourSettings;
  connection: ConnectionSettings;
  /** commandId → keybind string (e.g. "Mod+K"); empty string = unbound. */
  keybinds: Record<string, string>;
  plugins: Record<string, PluginEntry>;
  quickCss: string;
}

/** Same-origin dev/preview proxy path to the daemon (see vite.config.ts). */
export const DEFAULT_DAEMON_URL = '/signal-cli';
/** v1's default, which a browser can't use directly (no CORS on the daemon). */
const LEGACY_DAEMON_URL = 'http://127.0.0.1:8080';

export function defaultSettings(): Settings {
  return {
    appearance: {
      themeId: 'ember',
      accent: null,
      density: 'cozy',
      fontScale: 1,
      zoom: 1,
      saturation: 1,
      reducedMotion: 'system',
      showAvatarsInCompact: false,
      clock24h: true,
    },
    notifications: { enabled: true, mode: 'all', sound: true, showPreview: true },
    behaviour: {
      enterToSend: true,
      sendTypingIndicators: true,
      sendReadReceipts: true,
      markdown: true,
      linkPreviews: false,
    },
    connection: {
      backend: null,
      daemonUrl: DEFAULT_DAEMON_URL,
      account: null,
      mockLiveliness: true,
    },
    keybinds: {},
    plugins: {},
    quickCss: '',
  };
}

type SectionKey = 'appearance' | 'notifications' | 'behaviour' | 'connection';

export interface SettingsState extends Settings {
  update<K extends SectionKey>(section: K, patch: Partial<Settings[K]>): void;
  setKeybind(commandId: string, keybind: string | null): void;
  setPluginEnabled(pluginId: string, enabled: boolean): void;
  setPluginSetting(pluginId: string, key: string, value: unknown): void;
  setQuickCss(css: string): void;
  reset(): void;
}

export type SettingsStore = StoreApi<SettingsState>;

export function createSettingsStore(initial: Settings = defaultSettings()): SettingsStore {
  return createStore<SettingsState>()((set, get) => ({
    ...initial,

    update: (section, patch) => {
      set((s) => ({ [section]: { ...s[section], ...patch } }));
    },
    setKeybind: (commandId, keybind) => {
      set((s) => {
        const { [commandId]: _removed, ...rest } = s.keybinds;
        return { keybinds: keybind === null ? rest : { ...rest, [commandId]: keybind } };
      });
    },
    setPluginEnabled: (pluginId, enabled) => {
      const entry: PluginEntry = get().plugins[pluginId] ?? { settings: {} };
      set((s) => ({ plugins: { ...s.plugins, [pluginId]: { ...entry, enabled } } }));
    },
    setPluginSetting: (pluginId, key, value) => {
      const entry: PluginEntry = get().plugins[pluginId] ?? { settings: {} };
      set((s) => ({
        plugins: {
          ...s.plugins,
          [pluginId]: { ...entry, settings: { ...entry.settings, [key]: value } },
        },
      }));
    },
    setQuickCss: (quickCss) => {
      set({ quickCss });
    },
    reset: () => {
      set(defaultSettings());
    },
  }));
}

export const settingsSelectors = {
  appearance: (s: SettingsState) => s.appearance,
  notifications: (s: SettingsState) => s.notifications,
  behaviour: (s: SettingsState) => s.behaviour,
  connection: (s: SettingsState) => s.connection,
  keybinds: (s: SettingsState) => s.keybinds,
  plugins: (s: SettingsState) => s.plugins,
  quickCss: (s: SettingsState) => s.quickCss,
  clock24h: (s: SettingsState) => s.appearance.clock24h,
};

export function selectSettingsData(s: SettingsState): Settings {
  return {
    appearance: s.appearance,
    notifications: s.notifications,
    behaviour: s.behaviour,
    connection: s.connection,
    keybinds: s.keybinds,
    plugins: s.plugins,
    quickCss: s.quickCss,
  };
}

// ─── Parsing ──────────────────────────────────────────────────────────────

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
const HEX = /^#[0-9a-f]{6}$/iu;

export function parseSettings(data: unknown): Settings {
  const d = defaultSettings();
  const root = isRecord(data) ? data : {};
  const a = isRecord(root.appearance) ? root.appearance : {};
  const n = isRecord(root.notifications) ? root.notifications : {};
  const b = isRecord(root.behaviour) ? root.behaviour : {};
  const c = isRecord(root.connection) ? root.connection : {};

  const plugins: Record<string, PluginEntry> = {};
  if (isRecord(root.plugins)) {
    for (const [id, entry] of Object.entries(root.plugins)) {
      if (!isRecord(entry)) continue;
      plugins[id] = {
        ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
        settings: isRecord(entry.settings) ? { ...entry.settings } : {},
      };
    }
  }
  const keybinds: Record<string, string> = {};
  if (isRecord(root.keybinds)) {
    for (const [id, kb] of Object.entries(root.keybinds))
      if (typeof kb === 'string') keybinds[id] = kb;
  }

  return {
    appearance: {
      themeId: str(a.themeId, d.appearance.themeId),
      accent: typeof a.accent === 'string' && HEX.test(a.accent) ? a.accent : null,
      density: oneOf(a.density, ['cozy', 'compact'], d.appearance.density),
      fontScale: num(a.fontScale, d.appearance.fontScale, 0.875, 1.25),
      zoom: num(a.zoom, d.appearance.zoom, 0.8, 1.5),
      saturation: num(a.saturation, d.appearance.saturation, 0, 1),
      reducedMotion: oneOf(a.reducedMotion, ['system', 'on', 'off'], d.appearance.reducedMotion),
      showAvatarsInCompact: bool(a.showAvatarsInCompact, d.appearance.showAvatarsInCompact),
      clock24h: bool(a.clock24h, d.appearance.clock24h),
    },
    notifications: {
      enabled: bool(n.enabled, d.notifications.enabled),
      mode: oneOf(n.mode, ['all', 'mentions', 'none'], d.notifications.mode),
      sound: bool(n.sound, d.notifications.sound),
      showPreview: bool(n.showPreview, d.notifications.showPreview),
    },
    behaviour: {
      enterToSend: bool(b.enterToSend, d.behaviour.enterToSend),
      sendTypingIndicators: bool(b.sendTypingIndicators, d.behaviour.sendTypingIndicators),
      sendReadReceipts: bool(b.sendReadReceipts, d.behaviour.sendReadReceipts),
      markdown: bool(b.markdown, d.behaviour.markdown),
      linkPreviews: bool(b.linkPreviews, d.behaviour.linkPreviews),
    },
    connection: {
      backend: c.backend === 'mock' || c.backend === 'signal-cli' ? c.backend : null,
      daemonUrl:
        typeof c.daemonUrl === 'string' && c.daemonUrl.trim()
          ? c.daemonUrl.trim()
          : d.connection.daemonUrl,
      account: typeof c.account === 'string' && c.account ? c.account : null,
      mockLiveliness: bool(c.mockLiveliness, d.connection.mockLiveliness),
    },
    keybinds,
    plugins,
    quickCss: str(root.quickCss, d.quickCss),
  };
}

export const settingsSchema: VersionedSchema<Settings> = {
  key: 'hearth.settings',
  version: 2,
  migrations: {
    // v2 (P5): `connection.account`; the untouched v1 default daemon URL moves
    // to the same-origin proxy path (a custom URL is kept as the user set it).
    2: (data) => {
      if (!isRecord(data) || !isRecord(data.connection)) return data;
      const connection: Record<string, unknown> = { ...data.connection, account: null };
      if (connection.daemonUrl === LEGACY_DAEMON_URL) connection.daemonUrl = DEFAULT_DAEMON_URL;
      return { ...data, connection };
    },
  },
  defaults: defaultSettings,
  parse: parseSettings,
};
