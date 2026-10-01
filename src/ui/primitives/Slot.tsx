import { TriangleAlert } from 'lucide-react';
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';
import styles from './Slot.module.css';

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
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    if (this.props.onError) this.props.onError(error, this.props.entry);
    else console.error(`[shrike] plugin "${this.props.entry.owner}" failed to render`, error);
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.entry.component !== this.props.entry.component) {
      this.setState({ failed: false });
    }
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { owner } = this.props.entry;
    return (
      <span className={styles.failed} role="status">
        <Tooltip label={`The "${owner}" plugin hit an error here. Other features keep working.`}>
          <span className={styles.failedLabel} tabIndex={0}>
            <TriangleAlert size={12} aria-hidden />
            {owner} failed
          </span>
        </Tooltip>
        <button type="button" className={styles.retry} onClick={this.retry}>
          Retry
        </button>
      </span>
    );
  }
}
