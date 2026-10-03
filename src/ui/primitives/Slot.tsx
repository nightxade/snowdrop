import { TriangleAlert } from 'lucide-react';
import {
  Component,
  createContext,
  type ComponentType,
  type ContextType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Tooltip } from './Tooltip';
import styles from './Slot.module.css';

/** Display names for plugin ids (the app provides the runtime's names). */
export const PluginNamesContext = createContext<(owner: string) => string>((owner) => owner);

/** One contribution to a slot: an opaque component value supplied by a plugin. */
export interface SlotEntry {
  id: string;
  /** Plugin id, shown when the entry fails. */
  owner: string;
  component: unknown;
}

export interface SlotProps<P extends object> {
  /** Slot name, e.g. "chat.header.buttons"; exposed as data-slot for user CSS. */
  name: string;
  entries: readonly SlotEntry[];
  props: P;
  onError?: (error: unknown, entry: SlotEntry) => void;
  className?: string | undefined;
}

/** React components are functions, or objects (memo/forwardRef/lazy) tagged by React. */
export function isRenderableComponent<P>(value: unknown): value is ComponentType<P> {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && '$$typeof' in value)
  );
}

/**
 * Renders plugin-contributed components, each inside its own error boundary:
 * a crashing plugin turns into a small "failed" chip and never takes the
 * surrounding UI down with it.
 */
export function Slot<P extends object>({ name, entries, props, onError, className }: SlotProps<P>) {
  if (entries.length === 0) return null;
  return (
    <div className={[styles.slot, className].filter(Boolean).join(' ')} data-slot={name}>
      {entries.map((entry) => (
        <PluginBoundary
          key={`${entry.owner}:${entry.id}`}
          entry={entry}
          {...(onError ? { onError } : {})}
        >
          <SlotItem entry={entry} props={props} />
        </PluginBoundary>
      ))}
    </div>
  );
}

function SlotItem({ entry, props }: { entry: SlotEntry; props: object }) {
  if (!isRenderableComponent<object>(entry.component)) {
    throw new TypeError(`Slot entry "${entry.id}" is not a React component`);
  }
  const Rendered = entry.component;
  return <Rendered {...props} />;
}

interface BoundaryProps {
  entry: SlotEntry;
  children: ReactNode;
  onError?: (error: unknown, entry: SlotEntry) => void;
}

/**
 * Error boundary for one plugin contribution. It resets by itself when the
 * plugin supplies a new component (e.g. after being re-enabled or updated),
 * and offers Retry for transient failures.
 */
export class PluginBoundary extends Component<BoundaryProps, { failed: boolean }> {
  static override contextType = PluginNamesContext;
  declare context: ContextType<typeof PluginNamesContext>;
  /**
   * One visible chip per plugin: a decoration that crashes on every message
   * would otherwise put a chip on every row. The first failing boundary of a
   * plugin shows it; the others render nothing.
   */
  private static readonly showing = new Map<string, PluginBoundary>();
  /** Failed boundaries, so the others re-render when the visible chip changes hands. */
  private static readonly failedOnes = new Set<PluginBoundary>();
  override state = { failed: false };

  /** Makes this the boundary that shows its plugin's chip (if none does), and tells the rest. */
  private claim(): void {
    const owner = this.props.entry.owner;
    PluginBoundary.failedOnes.add(this);
    const shown = PluginBoundary.showing.get(owner);
    if (shown) {
      // Rendered its chip in the same pass as the owner of the chip: hide it.
      if (shown !== this) this.forceUpdate();
      return;
    }
    PluginBoundary.showing.set(owner, this);
    for (const other of PluginBoundary.failedOnes)
      if (other !== this && other.props.entry.owner === owner) other.forceUpdate();
  }

  private release(): void {
    const owner = this.props.entry.owner;
    PluginBoundary.failedOnes.delete(this);
    if (PluginBoundary.showing.get(owner) !== this) return;
    PluginBoundary.showing.delete(owner);
    // Hand the chip to another failed boundary of the same plugin, if any.
    for (const other of PluginBoundary.failedOnes)
      if (other.props.entry.owner === owner) {
        other.claim();
        other.forceUpdate();
        break;
      }
  }

  override componentWillUnmount(): void {
    this.release();
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.claim();
    if (this.props.onError) this.props.onError(error, this.props.entry);
    else console.error(`[snowdrop] plugin "${this.props.entry.owner}" failed to render`, error);
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.entry.component !== this.props.entry.component) {
      this.setState({ failed: false });
    }
  }

  private readonly retry = (): void => {
    this.release();
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { owner } = this.props.entry;
    // Another mounted boundary of this plugin already shows the chip.
    const first = PluginBoundary.showing.get(owner);
    if (first && first !== this) return null;
    const name = this.context(owner);
    return (
      <span className={styles.failed} role="status">
        <Tooltip label={`${name} hit an error here. Other features keep working.`}>
          <span className={styles.failedLabel} tabIndex={0}>
            <TriangleAlert size={12} aria-hidden />
            {name} failed
          </span>
        </Tooltip>
        <button type="button" className={styles.retry} onClick={this.retry}>
          Retry
        </button>
      </span>
    );
  }
}
