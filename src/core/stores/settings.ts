/**
 * User settings, persisted and versioned.
 *
 * Every section is parsed field-by-field against its defaults on load, so a
 * corrupted or partially-written value degrades to the default for *that
 * field* instead of resetting everything.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { BackendKind } from '@/core/backend';
import { isRecord, type VersionedSchema } from '@/core/persistence';

export type Density = 'comfortable' | 'compact';
/** 'tui' is the boxed-panes, monospace layout (PLAN: TUI layout). */
export type Shell = 'standard' | 'tui';
export type ReducedMotion = 'system' | 'on' | 'off';
export type NotificationMode = 'all' | 'mentions' | 'none';

export interface AppearanceSettings {
  themeId: string;
  /** Hex accent override, or null for the theme's own accent. */
  accent: string | null;
  density: Density;
  /** 'tui' boxes every region with titled borders, monospace type and a status line. */
  shell: Shell;
  /** 0.875–1.25 */
  fontScale: number;
  /** 0.8–1.5 */
  zoom: number;
  /** 0–1 */
  saturation: number;
  reducedMotion: ReducedMotion;
  showAvatarsInCompact: boolean;
  clock24h: boolean;
  /** Thicker, higher-contrast keyboard focus outline. */
  strongFocus: boolean;
  /** Larger rows and buttons for touch / motor accessibility. */
  largeTargets: boolean;
  /** Home lists direct messages and groups in separate sections, instead of one list. */
  splitHomeByType: boolean;
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
  /**
   * On by default. The desktop app fetches the page directly to build the
   * preview, so the site you're linking to sees your IP; recipients never
   * contact the site themselves.
   */
  linkPreviews: boolean;
  /**
   * Off by default: opening a conversation (switcher, notification, sidebar
   * next/previous, Vim J/K) puts keyboard focus on the message list instead
   * of the composer. On restores putting it straight in the composer.
   */
  focusComposerOnOpen: boolean;
  /**
   * Settings → Data & storage → Diagnostics: raises the app's own log floor
   * to Debug (desktop: `log_set_verbose`; the console sink always shows
   * every level regardless). Off by default — Debug lines are only useful
   * while actually diagnosing something.
   */
  verboseLogging: boolean;
}

export interface ConnectionSettings {
  /**
   * A registered backend kind (`app/backends.ts`), chosen on the welcome
   * screen; null until the user picks, or when the stored kind isn't
   * registered in this build.
   */
  backend: BackendKind | null;
  /**
   * Base URL the *browser* uses to reach signal-cli. The default is the
   * same-origin Vite proxy path (`/signal-cli` → SNOWDROP_SIGNAL_CLI_URL,
   * default http://127.0.0.1:8080), because the daemon sends no CORS headers
   * and pins the Host header. An absolute URL only works same-origin.
   */
  daemonUrl: string;
  /** signal-cli account (ACI or number) in multi-account mode; null = the only/first one. */
  account: string | null;
  /** Mock only: simulated activity. */
  mockLiveliness: boolean;
  /** Desktop app only: how it reaches signal-cli (the browser uses `daemonUrl`). */
  desktop: DesktopConnection;
}

/**
 * How the desktop app reaches signal-cli. By default it runs signal-cli as a
 * child process (`signal-cli jsonRpc`) — downloaded into the app's own data
 * directory the first time it's needed, or a build-time bundled sidecar in a
 * `tauri:build:bundled` build; an external HTTP daemon on this computer is
 * the advanced alternative.
 */
export interface DesktopConnection {
  mode: 'spawn' | 'external';
  /** Spawn: absolute path of a signal-cli you installed ('' = auto: downloaded, then bundled, then PATH). */
  binaryPath: string;
  /** Spawn: run signal-cli for this account only (`-a`); '' = multi-account. */
  account: string;
  /** External: the daemon's address (loopback only). */
  externalUrl: string;
}

export const DEFAULT_DESKTOP_CONNECTION: DesktopConnection = {
  mode: 'spawn',
  binaryPath: '',
  account: '',
  externalUrl: 'http://127.0.0.1:8080',
};

/** A user-imported theme (Settings → Themes). Validated on import and on load. */
export interface CustomThemeData {
  id: string;
  name: string;
  kind: 'dark' | 'light';
  tokens: Record<string, string>;
  css: string;
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
  /** Custom CSS (Settings → Custom CSS), applied last. */
  customCss: string;
  customThemes: CustomThemeData[];
}

/** Same-origin dev/preview proxy path to the daemon (see vite.config.ts). */
export const DEFAULT_DAEMON_URL = '/signal-cli';
/** v1's default, which a browser can't use directly (no CORS on the daemon). */
const LEGACY_DAEMON_URL = 'http://127.0.0.1:8080';

export function defaultSettings(): Settings {
  return {
    appearance: {
      themeId: 'dusk',
      accent: null,
      density: 'comfortable',
      shell: 'standard',
      fontScale: 1,
      zoom: 1,
      saturation: 1,
      reducedMotion: 'system',
      showAvatarsInCompact: false,
      clock24h: true,
      strongFocus: false,
      largeTargets: false,
      splitHomeByType: false,
    },
    notifications: { enabled: true, mode: 'all', sound: true, showPreview: true },
    behaviour: {
      enterToSend: true,
      sendTypingIndicators: true,
      sendReadReceipts: true,
      markdown: true,
      linkPreviews: true,
      focusComposerOnOpen: false,
      verboseLogging: false,
    },
    connection: {
      backend: null,
      daemonUrl: DEFAULT_DAEMON_URL,
      account: null,
      mockLiveliness: true,
      desktop: DEFAULT_DESKTOP_CONNECTION,
    },
    keybinds: {},
    plugins: {},
    customCss: '',
    customThemes: [],
  };
}

type SectionKey = 'appearance' | 'notifications' | 'behaviour' | 'connection';

export interface SettingsState extends Settings {
  update<K extends SectionKey>(section: K, patch: Partial<Settings[K]>): void;
  setKeybind(commandId: string, keybind: string | null): void;
  setPluginEnabled(pluginId: string, enabled: boolean): void;
  setPluginSetting(pluginId: string, key: string, value: unknown): void;
  /** Drops every stored value of a plugin, so its schema defaults apply. */
  resetPluginSettings(pluginId: string): void;
  setCustomCss(css: string): void;
  /** Adds or replaces (same id) a custom theme. */
  saveCustomTheme(theme: CustomThemeData): void;
  removeCustomTheme(id: string): void;
  /** Clears every keybind override. */
  resetKeybinds(): void;
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
    resetPluginSettings: (pluginId) => {
      const entry = get().plugins[pluginId];
      if (!entry || Object.keys(entry.settings).length === 0) return;
      set((s) => ({ plugins: { ...s.plugins, [pluginId]: { ...entry, settings: {} } } }));
    },
    setCustomCss: (customCss) => {
      set({ customCss });
    },
    saveCustomTheme: (theme) => {
      set((s) => {
        const index = s.customThemes.findIndex((t) => t.id === theme.id);
        const customThemes = [...s.customThemes];
        if (index === -1) customThemes.push(theme);
        else customThemes[index] = theme;
        return { customThemes };
      });
    },
    removeCustomTheme: (id) => {
      set((s) => {
        const customThemes = s.customThemes.filter((t) => t.id !== id);
        // Falling back keeps the app themed if the active theme is removed.
        const appearance =
          s.appearance.themeId === id ? { ...s.appearance, themeId: 'dusk' } : s.appearance;
        return { customThemes, appearance };
      });
    },
    resetKeybinds: () => {
      set({ keybinds: {} });
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
  customCss: (s: SettingsState) => s.customCss,
  customThemes: (s: SettingsState) => s.customThemes,
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
    customCss: s.customCss,
    customThemes: s.customThemes,
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

/** Syntax of a backend kind; which kinds exist is the backend registry's business. */
const BACKEND_KIND = /^[a-z][a-z0-9-]{0,31}$/u;

export interface SettingsParseOptions {
  /** Whether a stored backend kind is registered; unknown kinds parse as null. */
  isBackendKind?: (kind: string) => boolean;
}

export function parseSettings(data: unknown, options: SettingsParseOptions = {}): Settings {
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
      density: oneOf(a.density, ['comfortable', 'compact'], d.appearance.density),
      shell: oneOf(a.shell, ['standard', 'tui'], d.appearance.shell),
      fontScale: num(a.fontScale, d.appearance.fontScale, 0.875, 1.25),
      zoom: num(a.zoom, d.appearance.zoom, 0.8, 1.5),
      saturation: num(a.saturation, d.appearance.saturation, 0, 1),
      reducedMotion: oneOf(a.reducedMotion, ['system', 'on', 'off'], d.appearance.reducedMotion),
      showAvatarsInCompact: bool(a.showAvatarsInCompact, d.appearance.showAvatarsInCompact),
      clock24h: bool(a.clock24h, d.appearance.clock24h),
      strongFocus: bool(a.strongFocus, d.appearance.strongFocus),
      largeTargets: bool(a.largeTargets, d.appearance.largeTargets),
      splitHomeByType: bool(a.splitHomeByType, d.appearance.splitHomeByType),
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
      focusComposerOnOpen: bool(b.focusComposerOnOpen, d.behaviour.focusComposerOnOpen),
      verboseLogging: bool(b.verboseLogging, d.behaviour.verboseLogging),
    },
    connection: {
      backend:
        typeof c.backend === 'string' &&
        BACKEND_KIND.test(c.backend) &&
        (options.isBackendKind?.(c.backend) ?? true)
          ? c.backend
          : null,
      daemonUrl:
        typeof c.daemonUrl === 'string' && c.daemonUrl.trim()
          ? c.daemonUrl.trim()
          : d.connection.daemonUrl,
      account: typeof c.account === 'string' && c.account ? c.account : null,
      mockLiveliness: bool(c.mockLiveliness, d.connection.mockLiveliness),
      desktop: parseDesktopConnection(c.desktop),
    },
    keybinds,
    plugins,
    customCss: str(root.customCss, d.customCss),
    customThemes: Array.isArray(root.customThemes)
      ? root.customThemes.map(parseCustomTheme).filter((t): t is CustomThemeData => t !== null)
      : [],
  };
}

/** Shape and length only; the Rust side validates paths, accounts and URLs before use. */
function parseDesktopConnection(value: unknown): DesktopConnection {
  const d = DEFAULT_DESKTOP_CONNECTION;
  if (!isRecord(value)) return d;
  const text = (v: unknown, fallback: string) =>
    typeof v === 'string' && v.length <= 4096 ? v : fallback;
  return {
    mode: value.mode === 'external' ? 'external' : 'spawn',
    binaryPath: text(value.binaryPath, d.binaryPath),
    account: text(value.account, d.account),
    externalUrl: text(value.externalUrl, d.externalUrl).trim() || d.externalUrl,
  };
}

const THEME_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;

/** Structural check only; token names/values are validated by the theme engine on import. */
function parseCustomTheme(value: unknown): CustomThemeData | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !THEME_ID.test(value.id)) return null;
  if (typeof value.name !== 'string' || !value.name.trim()) return null;
  const tokens: Record<string, string> = {};
  if (isRecord(value.tokens))
    for (const [k, v] of Object.entries(value.tokens)) if (typeof v === 'string') tokens[k] = v;
  return {
    id: value.id,
    name: value.name.trim().slice(0, 40),
    kind: value.kind === 'light' ? 'light' : 'dark',
    tokens,
    css: typeof value.css === 'string' ? value.css : '',
  };
}

/**
 * The persisted settings schema. The composition root passes the backend
 * registry's `has` so a kind this build doesn't know falls back to the
 * welcome screen; `settingsSchema` (no registry) accepts any well-formed kind.
 */
export function createSettingsSchema(
  options: SettingsParseOptions = {},
): VersionedSchema<Settings> {
  return {
    ...settingsSchema,
    parse: (data) => parseSettings(data, options),
  };
}

export const settingsSchema: VersionedSchema<Settings> = {
  key: 'snowdrop.settings',
  version: 4,
  migrations: {
    // v2 (P5): `connection.account`; the untouched v1 default daemon URL moves
    // to the same-origin proxy path (a custom URL is kept as the user set it).
    2: (data) => {
      if (!isRecord(data) || !isRecord(data.connection)) return data;
      const connection: Record<string, unknown> = { ...data.connection, account: null };
      if (connection.daemonUrl === LEGACY_DAEMON_URL) connection.daemonUrl = DEFAULT_DAEMON_URL;
      return { ...data, connection };
    },
    // v3 (P4 review): QuickCSS is now "Custom CSS" (`customCss`), and the
    // Silent Typing plugin became the Privacy switch: an enabled plugin turns
    // `behaviour.sendTypingIndicators` off.
    3: (data) => {
      if (!isRecord(data)) return data;
      const out: Record<string, unknown> = { ...data };
      if ('quickCss' in out) {
        out.customCss = out.quickCss;
        delete out.quickCss;
      }
      if (isRecord(out.plugins) && isRecord(out.plugins['silent-typing'])) {
        const { 'silent-typing': silent, ...plugins } = out.plugins;
        if (isRecord(silent) && silent.enabled === true) {
          const behaviour = isRecord(out.behaviour) ? out.behaviour : {};
          out.behaviour = { ...behaviour, sendTypingIndicators: false };
        }
        out.plugins = plugins;
      }
      return out;
    },
    // v4: link previews are now on by default — there was no UI toggle for
    // it until the link-previews feature shipped, so a stored `false` only
    // ever reflects the old default, never a deliberate choice.
    4: (data) => {
      if (!isRecord(data)) return data;
      const behaviour = isRecord(data.behaviour) ? data.behaviour : {};
      return { ...data, behaviour: { ...behaviour, linkPreviews: true } };
    },
  },
  defaults: defaultSettings,
  parse: (data) => parseSettings(data),
};
