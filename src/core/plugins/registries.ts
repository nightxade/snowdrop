/**
 * Extension points. Each is an observable list so the UI can subscribe and
 * re-render when plugins come and go. Registries are React-agnostic: UI
 * components supplied by plugins are typed by their props only
 * (`ComponentLike<P>`) and rendered by the ui/ layer inside error boundaries.
 * Plugin callbacks the UI invokes (hover actions, menu items, header buttons)
 * go through `invoke` / `isVisible`, so their failures are reported against
 * the plugin like every other plugin error.
 */
import { CommandRegistry, KeyLayerStack } from '@/core/commands';
import type { Contact, Conversation, ConversationId, Message } from '@/core/domain';
import { createLogger, ObservableList } from '@/core/lib';
import { isValidDraft, type DraftPipeline, type OutgoingDraft } from '@/core/services';
import type { SpaceId } from '@/core/stores';

/**
 * A UI component contributed by a plugin, typed by its props: a React
 * component in practice (function components, and memo/forwardRef components
 * such as lucide icons, which React's types also declare callable). Core stays
 * React-free; the return type is the ui/ layer's business. ui/ still checks
 * at runtime that the value is renderable.
 */
export type ComponentLike<P> = (props: P) => unknown;

/** Props of message accessories and decorations (`message.accessories`, `message.decorations`). */
export interface MessageSlotProps {
  message: Message;
}

/** Props of composer accessories (`composer.accessories`). */
export interface ComposerSlotProps {
  conversationId: ConversationId;
  /**
   * Id the composer's text field lists in `aria-describedby`. An accessory
   * that shows the field's state (Vim's mode pill) puts it on that element,
   * so screen readers announce the state with the field. At most one
   * accessory should use it.
   */
  descriptionId: string;
}

/** Status-line items (TUI shell) take no props: each reads its own state. */
export type StatusItemProps = Record<string, never>;

/** Props an icon receives (lucide-react icons fit). */
export interface IconProps {
  size?: number;
}

export type IconComponent = ComponentLike<IconProps>;

/** Settings panels are rendered with no props. */
export type PanelComponent = ComponentLike<Record<string, never>>;

export interface Owned {
  /** Id of the plugin (or "core") that contributed this entry. */
  owner: string;
}

export type SlashResult =
  /**
   * Send this text instead of the command. `format` says how to read it
   * ('markdown' when the text relies on escaping); the composer passes it on
   * as `OutgoingDraft.format`, so output is right regardless of the user's
   * markdown setting.
   */
  | { type: 'send'; text: string; format?: 'markdown' | 'plain' }
  /** Put this text into the composer for further editing. */
  | { type: 'replace'; text: string }
  /** Show an inline error in the composer. */
  | { type: 'error'; message: string }
  /** Handled; clear the composer. */
  | { type: 'done' };

export interface SlashCommand {
  /** Without the leading slash, lowercase: "shrug". */
  name: string;
  description: string;
  /** Hint shown in autocomplete, e.g. "<message>". */
  usage?: string;
  execute(
    args: string,
    context: { conversationId: ConversationId },
  ): SlashResult | Promise<SlashResult>;
}

export type SendTransform = (draft: OutgoingDraft) => OutgoingDraft | Promise<OutgoingDraft>;

/** Return false to suppress outgoing typing indicators for a conversation. */
export type TypingGuard = (conversationId: ConversationId) => boolean;

export interface ComponentEntry<P> {
  id: string;
  component: ComponentLike<P>;
}

export interface HoverAction {
  id: string;
  label: string;
  icon: IconComponent;
  /** May be async: a rejection is reported like a throw. */
  onClick(message: Message): void | Promise<void>;
  visible?(message: Message): boolean;
}

export interface MenuTargets {
  message: Message;
  conversation: Conversation;
  member: { contact: Contact; conversationId: ConversationId };
  space: { spaceId: SpaceId };
}

export type MenuLocation = keyof MenuTargets;

export interface MenuItem<T> {
  id: string;
  label: string;
  icon?: IconComponent;
  danger?: boolean;
  /** May be async: a rejection is reported like a throw. */
  onSelect(target: T): void | Promise<void>;
  visible?(target: T): boolean;
}

export interface HeaderButton {
  id: string;
  label: string;
  icon: IconComponent;
  /** May be async: a rejection is reported like a throw. */
  onClick(conversation: Conversation): void | Promise<void>;
  visible?(conversation: Conversation): boolean;
}

export interface SettingsPanel {
  id: string;
  title: string;
  component: PanelComponent;
}

/**
 * Marks an incoming message as important for notifications (like a mention):
 * return a short reason ("Keyword “deploy”") or null. Boosted messages
 * notify even in mentions-only mode and in muted conversations.
 */
export type NotificationBooster = (message: Message) => string | null;

export interface StyleEntry {
  id: string;
  css: string;
}

type Menus = { [L in MenuLocation]: ObservableList<Owned & MenuItem<MenuTargets[L]>> };

export class Registries implements DraftPipeline {
  readonly commands: CommandRegistry;
  readonly slash = new ObservableList<Owned & SlashCommand>();
  readonly sendTransforms = new ObservableList<Owned & { transform: SendTransform }>();
  readonly typingGuards = new ObservableList<Owned & { guard: TypingGuard }>();
  readonly messageAccessories = new ObservableList<Owned & ComponentEntry<MessageSlotProps>>();
  readonly messageDecorations = new ObservableList<Owned & ComponentEntry<MessageSlotProps>>();
  readonly hoverActions = new ObservableList<Owned & HoverAction>();
  readonly menus: Menus = {
    message: new ObservableList(),
    conversation: new ObservableList(),
    member: new ObservableList(),
    space: new ObservableList(),
  };
  readonly headerButtons = new ObservableList<Owned & HeaderButton>();
  readonly settingsPanels = new ObservableList<Owned & SettingsPanel>();
  readonly styles = new ObservableList<Owned & StyleEntry>();
  readonly notificationBoosters = new ObservableList<Owned & { boost: NotificationBooster }>();
  /** Components rendered inside the composer field (Vim mode's mode pill). */
  readonly composerAccessories = new ObservableList<Owned & ComponentEntry<ComposerSlotProps>>();
  /**
   * Items shown left-to-right in the TUI shell's status line (`status.items`):
   * core registers conversation/unread/connection directly (owner `'core'`,
   * see `src/app/statusItems.tsx`), plugins (Vim Mode's NORMAL/INSERT pill)
   * through `ctx.statusBar.addItem`.
   */
  readonly statusItems = new ObservableList<Owned & ComponentEntry<StatusItemProps>>();
  /** Modal key layers (see core/commands/keyLayer); consulted before keybinds. */
  readonly keyLayers: KeyLayerStack;
  /** Entries whose `visible` threw, reported once each (it runs on every render). */
  private readonly reportedVisible = new WeakSet<object>();

  constructor(
    private readonly onError: (
      error: unknown,
      owner: string,
      where: string,
    ) => void = defaultOnError,
    commands?: CommandRegistry,
  ) {
    this.keyLayers = new KeyLayerStack((error, entry) => {
      this.onError(error, entry.owner, `key layer "${entry.layer.id}"`);
    });
    this.commands =
      commands ??
      new CommandRegistry((error, command) => {
        this.onError(error, command.owner, `command "${command.id}"`);
      });
  }

  /**
   * Calls a plugin callback the UI triggers (a hover action's `onClick`, a
   * menu item's `onSelect`, a header button's `onClick`). A throw or a
   * rejected promise is reported against `entry.owner`; it never reaches the
   * caller.
   */
  invoke(entry: Owned & { id: string }, where: string, fn: () => unknown): void {
    const report = (error: unknown) => {
      this.onError(error, entry.owner, `${where} "${entry.id}"`);
    };
    try {
      const result = fn();
      if (result instanceof Promise) result.catch(report);
    } catch (error) {
      report(error);
    }
  }

  /** Evaluates an entry's `visible`; one that throws hides the entry (reported once). */
  isVisible<T>(
    entry: Owned & { id: string; visible?(target: T): boolean },
    target: T,
    where: string,
  ): boolean {
    try {
      return entry.visible?.(target) ?? true;
    } catch (error) {
      if (!this.reportedVisible.has(entry)) {
        this.reportedVisible.add(entry);
        this.onError(error, entry.owner, `${where} "${entry.id}" visible()`);
      }
      return false;
    }
  }

  /**
   * Runs send transforms in registration order. A transform that throws or
   * returns something that isn't a valid draft for the same conversation is
   * skipped (and reported) — a buggy plugin must never block or redirect a send.
   */
  async transform(draft: OutgoingDraft): Promise<OutgoingDraft> {
    let current = draft;
    for (const entry of this.sendTransforms.list()) {
      try {
        const next: unknown = await entry.transform(current);
        if (isValidDraft(next, current)) current = next;
        else
          this.onError(
            new TypeError('Transform returned an invalid draft'),
            entry.owner,
            'send transform',
          );
      } catch (error) {
        this.onError(error, entry.owner, 'send transform');
      }
    }
    return current;
  }

  allowsTyping(conversationId: ConversationId): boolean {
    return this.typingGuards.list().every((entry) => {
      try {
        return entry.guard(conversationId);
      } catch (error) {
        this.onError(error, entry.owner, 'typing guard');
        return true;
      }
    });
  }

  /** First booster reason for a message; a throwing booster is skipped. */
  boostReason(message: Message): string | null {
    for (const entry of this.notificationBoosters.list()) {
      try {
        const reason = entry.boost(message);
        if (reason) return reason;
      } catch (error) {
        this.onError(error, entry.owner, 'notification booster');
      }
    }
    return null;
  }

  findSlash(name: string): (Owned & SlashCommand) | undefined {
    const lower = name.toLowerCase();
    return this.slash.list().find((c) => c.name === lower);
  }

  /** All plugin CSS, in registration order, for the theme engine's plugin <style>. */
  combinedCss(): string {
    return this.styles
      .list()
      .map((s) => `/* ${s.owner}:${s.id} */\n${s.css}`)
      .join('\n');
  }
}

function defaultOnError(error: unknown, owner: string, where: string): void {
  createLogger(`plugins:${owner}`).error(`failed in ${where}`, error);
}

/** Parses composer text into a slash invocation, or null if it isn't one. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/iu.exec(text.trimStart());
  if (!m) return null;
  return { name: (m[1] as string).toLowerCase(), args: (m[2] ?? '').trim() };
}
