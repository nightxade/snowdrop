/**
 * Contains a render error to one area of the window (sidebar, chat, member
 * panel, a dialog, a settings page), so the rest of the shell stays usable.
 * `AppErrorBoundary` (src/app) stays above everything as the last resort.
 *
 * A rejected `lazy()` import throws during render like any other error, so
 * place this above the area's `<Suspense>` and it catches a failed chunk too.
 *
 * Reporting: `componentDidCatch` is the single report per error, through the
 * same scoped logger the root boundary falls back to. The root's
 * `onCaughtError` (src/main.tsx) is a no-op, which silences React's own
 * default logging for caught errors, so nothing is reported twice.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createLogger } from '@/core/lib';
import { Button, Modal } from '@/ui/primitives';
import styles from './AreaErrorBoundary.module.css';

export interface AreaErrorBoundaryProps {
  children: ReactNode;
  /** What failed, for the fallback line: "the chat", "the sidebar". */
  area: string;
  /** Resets the boundary on its own when any of these change (a conversation id, a page id). */
  resetKeys?: readonly unknown[];
  /**
   * For a dialog: the fallback is itself a small dialog (header Close button,
   * Escape) that calls this, so a crashed dialog can still be dismissed.
   */
  onClose?: () => void;
  /** Defaults to the scoped logger at scope `app`. */
  report?: (error: unknown, where: string) => void;
}

interface State {
  error: Error | null;
}

function sameKeys(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

export class AreaErrorBoundary extends Component<AreaErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const report =
      this.props.report ??
      ((e: unknown, where: string) => {
        createLogger('app').error(where, e);
      });
    report(error, `caught render error in ${this.props.area}${info.componentStack ?? ''}`);
  }

  override componentDidUpdate(previous: AreaErrorBoundaryProps): void {
    if (this.state.error && !sameKeys(previous.resetKeys, this.props.resetKeys)) this.reset();
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const { area, onClose } = this.props;
    const message = `Something went wrong showing ${area}.`;
    if (onClose) {
      return (
        <Modal
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
          title="Something went wrong"
          description={message}
          footer={
            <Button variant="primary" onClick={this.reset}>
              Try again
            </Button>
          }
        />
      );
    }
    return (
      <div className={styles.fallback} role="alert" data-snowdrop="area-error">
        <p className={styles.message}>{message}</p>
        <Button size="sm" onClick={this.reset}>
          Try again
        </Button>
      </div>
    );
  }
}
