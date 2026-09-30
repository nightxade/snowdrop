import type { Command } from '@/core/commands';
import type { BackendKind } from '@/core/backend';
import type { ConnectionStatus, ConversationId, Message } from '@/core/domain';
import type { Disposer } from '@/core/lib';
import type { Stores, ToastKind } from '@/core/stores';
import type {
  HeaderButton,
  HoverAction,
  MenuItem,
  MenuLocation,
  MenuTargets,
  OpaqueComponent,
  SendTransform,
  SettingsPanel,
  SlashCommand,
  TypingGuard,
} from './registries';
import type { SettingsSchema, SettingsValues } from './settings';

/** Read-only view of a store: plugins observe state but change it only through actions/ctx APIs. */
export interface ReadonlyStore<S> {
  getState(): S;
  subscribe(listener: (state: S, previous: S) => void): () => void;
}

export type ReadonlyStores = {
  [K in keyof Stores]: ReadonlyStore<ReturnType<Stores[K]['getState']>>;
};

/** The narrow slice of messaging a plugin may drive. */
export interface PluginBackendFacade {
  readonly kind: BackendKind;
  status(): ConnectionStatus;
  /** Sends a plain/markdown text message through the normal send pipeline. */
  sendText(conversationId: ConversationId, text: string): Promise<void>;
  /** Called for every incoming or synced message after it's been stored. */
  onMessage(fn: (message: Message) => void): Disposer;
}

export interface PluginLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface PluginSettingsApi<S extends SettingsSchema> {
  get<K extends keyof S & string>(key: K): SettingsValues<S>[K];
  set<K extends keyof S & string>(key: K, value: SettingsValues<S>[K]): void;
  all(): SettingsValues<S>;
  /** Called with fresh values whenever this plugin's settings change. */
  subscribe(fn: (values: SettingsValues<S>) => void): Disposer;
}

/**
 * Everything a plugin can do. Every registration returns a disposer, but
 * plugins rarely need it: all registrations are tracked and undone when the
 * plugin stops, so a plugin can't leak into the app after being disabled.
 */
export interface PluginContext<S extends SettingsSchema = SettingsSchema> {
  readonly pluginId: string;
  readonly settings: PluginSettingsApi<S>;
  readonly commands: { register(command: Command): Disposer };
  readonly slash: { register(command: SlashCommand): Disposer };
  readonly send: {
    addTransform(transform: SendTransform): Disposer;
    addTypingGuard(guard: TypingGuard): Disposer;
  };
  readonly messages: {
    addAccessory(id: string, component: OpaqueComponent): Disposer;
    addDecoration(id: string, component: OpaqueComponent): Disposer;
    addHoverAction(action: HoverAction): Disposer;
  };
  readonly menus: {
    add<L extends MenuLocation>(location: L, item: MenuItem<MenuTargets[L]>): Disposer;
  };
  readonly headerBar: { addButton(button: HeaderButton): Disposer };
  readonly settingsPanels: { add(panel: SettingsPanel): Disposer };
  readonly styles: { inject(css: string, id?: string): Disposer };
  readonly stores: ReadonlyStores;
  readonly backend: PluginBackendFacade;
  toast(message: string, kind?: ToastKind): void;
  readonly log: PluginLogger;
  /** Registers arbitrary cleanup to run on stop (timers, subscriptions). */
  onDispose(fn: () => void): Disposer;
}

export interface PluginDefinition<S extends SettingsSchema = SettingsSchema> {
  /** Stable, kebab-case; used as the settings key. */
  id: string;
  name: string;
  description: string;
  authors: string[];
  tags?: string[];
  settings?: S;
  /** Enabled on first run (before the user ever toggles it). */
  enabledByDefault?: boolean;
  /** Core functionality built on the plugin API; cannot be disabled. */
  required?: boolean;
  /** Not yet functional in this build (shown as "coming soon"). */
  preview?: boolean;
  // Method syntax (not arrow properties) keeps definitions with specific
  // schemas assignable to PluginDefinition<SettingsSchema> for the runtime.
  start(ctx: PluginContext<S>): void | Promise<void>;
  stop?(ctx: PluginContext<S>): void | Promise<void>;
}

/** Identity helper giving full inference of the settings schema in `start`. */
export function definePlugin<const S extends SettingsSchema = SettingsSchema>(
  definition: PluginDefinition<S>,
): PluginDefinition<S> {
  return definition;
}

export interface PluginHost {
  stores: Stores;
  backend: PluginBackendFacade;
  toast(message: string, kind: ToastKind, pluginId: string): void;
  onError?(error: unknown, pluginId: string, where: string): void;
}
