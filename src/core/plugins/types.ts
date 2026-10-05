import type { Command, KeyLayer } from '@/core/commands';
import type { BackendKind } from '@/core/backend';
import type { ConnectionStatus, Conversation, ConversationId, Message } from '@/core/domain';
import type { Disposer } from '@/core/lib';
import type { Stores, ToastKind } from '@/core/stores';
import type {
  ComponentLike,
  ComposerSlotProps,
  HeaderButton,
  HoverAction,
  MenuItem,
  MenuLocation,
  MenuTargets,
  MessageSlotProps,
  NotificationBooster,
  SendTransform,
  SettingsPanel,
  SlashCommand,
  TypingGuard,
} from './registries';
import type { SettingsSchema, SettingsValues } from './settings';
import type { PluginState } from './state';

/** Read-only view of a store: plugins observe state but change it only through actions/ctx APIs. */
export interface ReadonlyStore<S> {
  getState(): S;
  subscribe(listener: (state: S, previous: S) => void): () => void;
}

export type ReadonlyStores = {
  [K in keyof Stores]: ReadonlyStore<ReturnType<Stores[K]['getState']>>;
};

/** How a message reached `onMessage`. */
export interface MessageArrival {
  /**
   * True when the message arrived while the app was running; false when it
   * was delivered as part of catching up at startup (messages that arrived
   * while the app was closed). Auto-replies usually want only live ones.
   */
  live: boolean;
}

/** The narrow slice of messaging a plugin may drive. */
export interface PluginBackendFacade {
  /** The transport's registered kind (`'mock'`, `'signal-cli'`, …). */
  readonly kind: BackendKind;
  status(): ConnectionStatus;
  /** Sends a plain/markdown text message through the normal send pipeline. */
  sendText(conversationId: ConversationId, text: string): Promise<void>;
  /** Called once per new incoming or synced message, after it's been stored. */
  onMessage(fn: (message: Message, arrival: MessageArrival) => void): Disposer;
}

/**
 * Actions on a given message, independent of focus or what is on screen
 * (the host implements them with the same services as the built-in UI).
 */
export interface PluginMessageActions {
  /** Starts a reply to `message` in its conversation's composer (opening it if needed). */
  reply(message: Message): void;
  /** Reacts with `emoji` (replacing your previous reaction, as Signal allows one). */
  react(message: Message, emoji: string): Promise<void>;
  /** Copies the message's text (mentions as names) to the clipboard, with a toast. */
  copy(message: Message): Promise<void>;
}

/** Read-only conversation lookups. */
export interface PluginConversations {
  get(id: ConversationId): Readonly<Conversation> | undefined;
  /** True for one-to-one conversations (known or not yet synced). */
  isDirect(id: ConversationId): boolean;
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
  readonly commands: {
    register(command: Command): Disposer;
    /** Runs any registered command by id (core ones included); false if missing or disabled. */
    execute(id: string): Promise<boolean>;
  };
  /** Modal key layers that see keys before keybinds and the focused widget. */
  readonly keys: { addLayer(layer: KeyLayer): Disposer };
  /** Components rendered inside the composer field. */
  readonly composer: {
    addAccessory(id: string, component: ComponentLike<ComposerSlotProps>): Disposer;
  };
  readonly slash: { register(command: SlashCommand): Disposer };
  readonly send: {
    addTransform(transform: SendTransform): Disposer;
    addTypingGuard(guard: TypingGuard): Disposer;
  };
  readonly messages: PluginMessageActions & {
    addAccessory(id: string, component: ComponentLike<MessageSlotProps>): Disposer;
    addDecoration(id: string, component: ComponentLike<MessageSlotProps>): Disposer;
    addHoverAction(action: HoverAction): Disposer;
  };
  readonly conversations: PluginConversations;
  readonly menus: {
    add<L extends MenuLocation>(location: L, item: MenuItem<MenuTargets[L]>): Disposer;
  };
  readonly headerBar: { addButton(button: HeaderButton): Disposer };
  readonly settingsPanels: { add(panel: SettingsPanel): Disposer };
  readonly styles: { inject(css: string, id?: string): Disposer };
  readonly notifications: { addBooster(booster: NotificationBooster): Disposer };
  readonly stores: ReadonlyStores;
  readonly backend: PluginBackendFacade;
  /**
   * A reactive value owned by this plugin (read it in components with
   * `usePluginState` from `@/ui/hooks`). Listeners are dropped on stop.
   */
  state<T>(initial: T): PluginState<T>;
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
export function defineExtension<const S extends SettingsSchema = SettingsSchema>(
  definition: PluginDefinition<S>,
): PluginDefinition<S> {
  return definition;
}

export interface PluginHost {
  stores: Stores;
  backend: PluginBackendFacade;
  /** Message actions; tests may omit them (calls then throw "not available"). */
  messages?: PluginMessageActions;
  toast(message: string, kind: ToastKind, pluginId: string): void;
  onError?(error: unknown, pluginId: string, where: string): void;
}
