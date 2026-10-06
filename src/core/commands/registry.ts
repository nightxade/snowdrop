/**
 * Command registry: the single place actions live, whether they're invoked
 * from the palette, a keybind, a menu or a plugin. Framework-agnostic and
 * observable so the palette/keybind settings can re-render on change.
 */
import { createLogger, ObservableList, type Disposer, type Unsubscribe } from '@/core/lib';

const log = createLogger('app');
import {
  matchesKeybind,
  parseKeybind,
  serializeKeybind,
  type KeyEventLike,
  type Keybind,
} from './keybind';

export interface Command {
  id: string;
  title: string;
  /** Palette grouping, e.g. "Navigation", "Plugins". */
  category?: string;
  /** Default keybind ("Mod+K"); users can override in settings. */
  keybind?: string;
  /** Run even when focus is in a text field (e.g. the quick switcher). */
  allowInInputs?: boolean;
  /** Hide from the palette (keybind-only commands). */
  hidden?: boolean;
  /** Return false to make the command temporarily unavailable. */
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

export interface RegisteredCommand extends Command {
  /** Plugin id (or "core") that registered it; used for attribution and cleanup. */
  owner: string;
}

export class DuplicateCommandError extends Error {
  override name = 'DuplicateCommandError';
}

export class CommandRegistry {
  private readonly list = new ObservableList<RegisteredCommand>();

  constructor(
    private readonly onError: (error: unknown, command: RegisteredCommand) => void = defaultOnError,
  ) {}

  /** Throws on a duplicate id so a misbehaving plugin fails loudly at start, not silently at runtime. */
  register(command: Command, owner = 'core'): Disposer {
    if (this.get(command.id))
      throw new DuplicateCommandError(`Command "${command.id}" is already registered`);
    return this.list.add({ ...command, owner });
  }

  get(id: string): RegisteredCommand | undefined {
    return this.list.list().find((c) => c.id === id);
  }

  all(): readonly RegisteredCommand[] {
    return this.list.list();
  }

  subscribe(fn: () => void): Unsubscribe {
    return this.list.subscribe(fn);
  }

  /** Runs a command, isolating errors. Resolves false if missing, disabled or failed. */
  async execute(id: string): Promise<boolean> {
    const command = this.get(id);
    if (!command || command.enabled?.() === false) return false;
    try {
      await command.run();
      return true;
    } catch (error) {
      this.onError(error, command);
      return false;
    }
  }
}

function defaultOnError(error: unknown, command: Command): void {
  log.error(`command "${command.id}" failed`, error);
}

/**
 * Effective keybinds: user overrides win over defaults; an empty override
 * string unbinds. Unparseable strings are ignored.
 */
export function resolveKeybinds(
  commands: readonly Command[],
  overrides: Readonly<Record<string, string>>,
): Map<string, Keybind> {
  const out = new Map<string, Keybind>();
  for (const c of commands) {
    const source = c.id in overrides ? overrides[c.id] : c.keybind;
    if (!source) continue;
    const kb = parseKeybind(source);
    if (kb) out.set(c.id, kb);
  }
  return out;
}

/** Groups of command ids that share the same keybind. */
export function findKeybindConflicts(bindings: ReadonlyMap<string, Keybind>): string[][] {
  const byCombo = new Map<string, string[]>();
  for (const [id, kb] of bindings) {
    const combo = serializeKeybind(kb);
    byCombo.set(combo, [...(byCombo.get(combo) ?? []), id]);
  }
  return [...byCombo.values()].filter((ids) => ids.length > 1);
}

export interface DispatchContext {
  /** True when focus is in an input/textarea/contenteditable. */
  inEditable: boolean;
}

/**
 * Maps key events to commands. The DOM listener lives in ui/; this stays
 * testable with plain objects. Returns the handled command id, if any, so the
 * caller can preventDefault.
 */
export class KeybindDispatcher {
  constructor(
    private readonly registry: CommandRegistry,
    private readonly getOverrides: () => Readonly<Record<string, string>>,
    private readonly isMac: boolean,
  ) {}

  handle(event: KeyEventLike, context: DispatchContext): string | null {
    const commands = this.registry.all();
    const bindings = resolveKeybinds(commands, this.getOverrides());
    for (const command of commands) {
      const kb = bindings.get(command.id);
      if (!kb || !matchesKeybind(event, kb, this.isMac)) continue;
      if (context.inEditable && !command.allowInInputs) continue;
      if (command.enabled?.() === false) continue;
      void this.registry.execute(command.id);
      return command.id;
    }
    return null;
  }
}
