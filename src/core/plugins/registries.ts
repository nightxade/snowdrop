/**
 * Extension points. Each is an observable list so the UI can subscribe and
 * re-render when plugins come and go. Registries are React-agnostic: UI
 * components supplied by plugins are stored as opaque values and rendered by
 * the ui/ layer inside error boundaries.
 */
import { CommandRegistry, KeyLayerStack } from '@/core/commands';
import type { Contact, Conversation, ConversationId, Message } from '@/core/domain';
import { ObservableList } from '@/core/lib';
import { isValidDraft, type DraftPipeline, type OutgoingDraft } from '@/core/services';
import type { SpaceId } from '@/core/stores';

/**
 * A UI component contributed by a plugin (a React component in practice).
 * Typed as unknown here so core stays framework-free; ui/ narrows it.
 */
export type OpaqueComponent = unknown;

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

export interface ComponentEntry {
  id: string;
  component: OpaqueComponent;
}

export interface HoverAction {
  id: string;
  label: string;
  icon: OpaqueComponent;
  onClick(message: Message): void;
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
  icon?: OpaqueComponent;
  danger?: boolean;
  onSelect(target: T): void;
  visible?(target: T): boolean;
}

export interface HeaderButton {
  id: string;
  label: string;
  icon: OpaqueComponent;
  onClick(conversation: Conversation): void;
  visible?(conversation: Conversation): boolean;
}

export interface SettingsPanel {
  id: string;
  title: string;
  component: OpaqueComponent;
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
  readonly messageAccessories = new ObservableList<Owned & ComponentEntry>();
  readonly messageDecorations = new ObservableList<Owned & ComponentEntry>();
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
  readonly composerAccessories = new ObservableList<Owned & ComponentEntry>();
  /** Modal key layers (see core/commands/keyLayer); consulted before keybinds. */
  readonly keyLayers: KeyLayerStack;

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
        this.onError(error, command.id, 'command');
      });
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
  console.error(`[shrike] plugin "${owner}" failed in ${where}`, error);
}

/** Parses composer text into a slash invocation, or null if it isn't one. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/iu.exec(text.trimStart());
  if (!m) return null;
  return { name: (m[1] as string).toLowerCase(), args: (m[2] ?? '').trim() };
}
