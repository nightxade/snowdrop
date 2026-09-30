/**
 * Extension points. Each is an observable list so the UI can subscribe and
 * re-render when plugins come and go. Registries are React-agnostic: UI
 * components supplied by plugins are stored as opaque values and rendered by
 * the ui/ layer inside error boundaries.
 */
import { CommandRegistry } from '@/core/commands';
import type { Contact, Conversation, ConversationId, Message } from '@/core/domain';
import { ObservableList } from '@/core/lib';
import type { DraftPipeline, OutgoingDraft } from '@/core/services';
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
  /** Send this text instead of the command. */
  | { type: 'send'; text: string }
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

  constructor(
    private readonly onError: (
      error: unknown,
      owner: string,
      where: string,
    ) => void = defaultOnError,
    commands?: CommandRegistry,
  ) {
    this.commands =
      commands ??
      new CommandRegistry((error, command) => {
        this.onError(error, command.id, 'command');
      });
  }

  /** Runs send transforms in registration order; a throwing transform is skipped, not fatal. */
  async transform(draft: OutgoingDraft): Promise<OutgoingDraft> {
    let current = draft;
    for (const entry of this.sendTransforms.list()) {
      try {
        current = await entry.transform(current);
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
  console.error(`[hearth] plugin "${owner}" failed in ${where}`, error);
}

/** Parses composer text into a slash invocation, or null if it isn't one. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/iu.exec(text.trimStart());
  if (!m) return null;
  return { name: (m[1] as string).toLowerCase(), args: (m[2] ?? '').trim() };
}
