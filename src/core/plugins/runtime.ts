/**
 * Plugin lifecycle: start/stop, per-plugin contexts with automatic disposal,
 * enable state persisted in settings, and error isolation (a plugin that
 * throws while starting is marked failed and cleaned up; others carry on).
 */
import { DisposableStore, type Disposer, type Unsubscribe } from '@/core/lib';
import type { Registries } from './registries';
import {
  coerceSetting,
  resolveSettings,
  type SettingsSchema,
  type SettingsValues,
} from './settings';
import type { PluginContext, PluginDefinition, PluginHost, PluginLogger } from './types';

export type PluginStatus = 'stopped' | 'starting' | 'running' | 'failed';

export interface PluginInfo {
  definition: PluginDefinition;
  enabled: boolean;
  status: PluginStatus;
  error?: unknown;
}

interface Slot {
  definition: PluginDefinition;
  status: PluginStatus;
  error?: unknown;
  disposables?: DisposableStore;
  ctx?: PluginContext;
  /** Serialises start/stop per plugin. */
  chain: Promise<void>;
}

export class DuplicatePluginError extends Error {
  override name = 'DuplicatePluginError';
}

export class PluginRuntime {
  private readonly slots = new Map<string, Slot>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly PluginInfo[] = [];
  private settingsUnsub: Unsubscribe | null = null;

  constructor(
    private readonly host: PluginHost,
    private readonly registries: Registries,
    plugins: readonly PluginDefinition[],
  ) {
    for (const definition of plugins) {
      if (this.slots.has(definition.id))
        throw new DuplicatePluginError(`Duplicate plugin id "${definition.id}"`);
      this.slots.set(definition.id, { definition, status: 'stopped', chain: Promise.resolve() });
    }
    this.rebuildSnapshot();
  }

  // ─── Queries ──────────────────────────────────────────────────────────

  /** Stable snapshot for UIs (same array until something changes). */
  list(): readonly PluginInfo[] {
    return this.snapshot;
  }

  get(id: string): PluginInfo | undefined {
    return this.snapshot.find((p) => p.definition.id === id);
  }

  subscribe(fn: () => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  isEnabled(id: string): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    if (slot.definition.required) return true;
    const entry = this.host.stores.settings.getState().plugins[id];
    return entry?.enabled ?? slot.definition.enabledByDefault ?? false;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Starts every enabled plugin and then follows the settings store, so
   * enabling/disabling from anywhere (settings UI, reset, import) takes
   * effect without a reload.
   */
  async startAll(): Promise<void> {
    await this.reconcile();
    this.settingsUnsub ??= this.host.stores.settings.subscribe((state, prev) => {
      // Only enablement changes matter here: changing a plugin's *settings*
      // must not restart it (or retry one that failed to start).
      if (state.plugins === prev.plugins) return;
      const toggled = [...this.slots.keys()].some(
        (id) => state.plugins[id]?.enabled !== prev.plugins[id]?.enabled,
      );
      if (toggled) void this.reconcile();
    });
  }

  async stopAll(): Promise<void> {
    this.settingsUnsub?.();
    this.settingsUnsub = null;
    await Promise.all([...this.slots.keys()].map((id) => this.stop(id)));
  }

  /** Persists the choice; the settings subscription (or this call) applies it. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || (slot.definition.required && !enabled)) return;
    this.host.stores.settings.getState().setPluginEnabled(id, enabled);
    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    await Promise.all(
      [...this.slots.keys()].map((id) => (this.isEnabled(id) ? this.start(id) : this.stop(id))),
    );
  }

  start(id: string): Promise<void> {
    return this.enqueue(id, async (slot) => {
      // Start/stop are serialised per plugin, so 'starting' is never observed here.
      if (slot.status === 'running') return;
      const disposables = new DisposableStore((error) => {
        this.report(error, id, 'dispose');
      });
      const ctx = this.createContext(slot.definition, disposables);
      slot.disposables = disposables;
      slot.ctx = ctx;
      slot.status = 'starting';
      delete slot.error;
      this.changed();
      try {
        await slot.definition.start(ctx);
        slot.status = 'running';
      } catch (error) {
        // Undo whatever it registered before failing.
        disposables.dispose();
        slot.status = 'failed';
        slot.error = error;
        delete slot.disposables;
        delete slot.ctx;
        this.report(error, id, 'start');
      }
      this.changed();
    });
  }

  stop(id: string): Promise<void> {
    return this.enqueue(id, async (slot) => {
      if (slot.status !== 'running') {
        if (slot.status === 'failed' && !this.isEnabled(id)) {
          slot.status = 'stopped';
          delete slot.error;
          this.changed();
        }
        return;
      }
      try {
        if (slot.ctx) await slot.definition.stop?.(slot.ctx);
      } catch (error) {
        this.report(error, id, 'stop');
      }
      slot.disposables?.dispose();
      delete slot.disposables;
      delete slot.ctx;
      slot.status = 'stopped';
      this.changed();
    });
  }

  private enqueue(id: string, fn: (slot: Slot) => Promise<void>): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return Promise.resolve();
    slot.chain = slot.chain.then(() => fn(slot));
    return slot.chain;
  }

  private changed(): void {
    this.rebuildSnapshot();
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (error) {
        console.error('[shrike] plugin runtime listener failed', error);
      }
    }
  }

  private rebuildSnapshot(): void {
    this.snapshot = [...this.slots.values()].map((slot) => {
      const info: PluginInfo = {
        definition: slot.definition,
        enabled: this.isEnabled(slot.definition.id),
        status: slot.status,
      };
      if (slot.error !== undefined) info.error = slot.error;
      return info;
    });
  }

  private report(error: unknown, id: string, where: string): void {
    if (this.host.onError) this.host.onError(error, id, where);
    else console.error(`[shrike] plugin "${id}" failed during ${where}`, error);
  }

  // ─── Context ──────────────────────────────────────────────────────────

  private createContext(definition: PluginDefinition, disposables: DisposableStore): PluginContext {
    const id = definition.id;
    const r = this.registries;
    const settingsStore = this.host.stores.settings;
    const schema: SettingsSchema = definition.settings ?? {};
    const track = (disposer: Disposer): Disposer => disposables.add(disposer);
    const read = (): SettingsValues<SettingsSchema> =>
      resolveSettings(schema, settingsStore.getState().plugins[id]?.settings ?? {});

    const log: PluginLogger = {
      info: (...args) => {
        console.info(`[plugin:${id}]`, ...args);
      },
      warn: (...args) => {
        console.warn(`[plugin:${id}]`, ...args);
      },
      error: (...args) => {
        console.error(`[plugin:${id}]`, ...args);
      },
    };

    let styleCounter = 0;
    return {
      pluginId: id,
      settings: {
        get: (key) => read()[key] as never,
        set: (key, value) => {
          const def = schema[key];
          if (!def) return;
          settingsStore.getState().setPluginSetting(id, key, coerceSetting(def, value));
        },
        all: read,
        subscribe: (fn) =>
          track(
            settingsStore.subscribe((state, prev) => {
              if (state.plugins[id]?.settings !== prev.plugins[id]?.settings) fn(read());
            }),
          ),
      },
      commands: { register: (command) => track(r.commands.register(command, id)) },
      slash: {
        register: (command) => {
          if (r.findSlash(command.name))
            throw new Error(`Slash command "/${command.name}" already exists`);
          return track(r.slash.add({ ...command, name: command.name.toLowerCase(), owner: id }));
        },
      },
      send: {
        addTransform: (transform) => track(r.sendTransforms.add({ transform, owner: id })),
        addTypingGuard: (guard) => track(r.typingGuards.add({ guard, owner: id })),
      },
      messages: {
        addAccessory: (entryId, component) =>
          track(r.messageAccessories.add({ id: entryId, component, owner: id })),
        addDecoration: (entryId, component) =>
          track(r.messageDecorations.add({ id: entryId, component, owner: id })),
        addHoverAction: (action) => track(r.hoverActions.add({ ...action, owner: id })),
      },
      menus: {
        add: (location, item) => track(r.menus[location].add({ ...item, owner: id })),
      },
      headerBar: { addButton: (button) => track(r.headerButtons.add({ ...button, owner: id })) },
      settingsPanels: { add: (panel) => track(r.settingsPanels.add({ ...panel, owner: id })) },
      styles: {
        inject: (css, styleId) =>
          track(r.styles.add({ id: styleId ?? `style-${++styleCounter}`, css, owner: id })),
      },
      stores: this.host.stores,
      backend: {
        kind: this.host.backend.kind,
        status: () => this.host.backend.status(),
        sendText: (conversationId, text) => this.host.backend.sendText(conversationId, text),
        onMessage: (fn) => track(this.host.backend.onMessage(fn)),
      },
      toast: (message, kind = 'info') => {
        this.host.toast(message, kind, id);
      },
      log,
      onDispose: (fn) => track(fn),
    };
  }
}
