/**
 * Contains a render error to one area of the window (sidebar, chat, member
 * panel, a dialog, a settings page), so the rest of the shell stays usable.
 * `AppErrorBoundary` (src/app) stays above everything as the last resort.
 *
 * A rejected `lazy()` import throws during render like any other error, so
 * place this above the area's `<Suspense>` and it catches a failed chunk too
 * (it is shown, not recovered: React keeps a rejected `lazy()` promise, so
 * "Try again" renders the same failure at once, and a dialog's Close is the way out).
 *
 * Focus: when the fallback appears and focus has fallen to the page (the
 * crashed area held it), the fallback takes it, as `AppErrorBoundary`'s does;
 * focus that is somewhere else is left there. After "Try again" focus goes to
 * the area's container (the fallback's parent) if it has fallen to the page.
 *
 * Reporting: `componentDidCatch` is the single report per error, through the
 * same scoped logger the root boundary falls back to. The root's
 * `onCaughtError` (src/main.tsx) is a no-op, which silences React's own
 * default logging for caught errors, so nothing is reported twice.
 */
import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';
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
  /** A thin strip (a header, a banner): the fallback is one slim row instead of filling the area. */
  compact?: boolean;
  /** Defaults to the scoped logger at scope `app`. */
  report?: (error: unknown, where: string) => void;
}

interface State {
  error: Error | null;
}

function sameKeys(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/** Focus is on nothing (the focused element was removed): the page itself holds it. */
function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
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

  override componentDidMount(): void {
    this.focusFallback();
  }

  override componentDidUpdate(previous: AreaErrorBoundaryProps, before: State): void {
    if (this.state.error && !sameKeys(previous.resetKeys, this.props.resetKeys)) this.reset();
    else if (this.state.error && !before.error) this.focusFallback();
    else if (!this.state.error && before.error) this.restoreFocus();
  }

  private readonly fallback = createRef<HTMLDivElement>();
  /** The area's container, noted when "Try again" is pressed (the fallback is gone afterwards). */
  private returnTo: HTMLElement | null = null;

  /** Only when focus fell to the page, so it is never taken from elsewhere. */
  private focusFallback(): void {
    if (focusIsLost()) this.fallback.current?.focus();
  }

  private restoreFocus(): void {
    const target = this.returnTo;
    this.returnTo = null;
    if (!target?.isConnected || !focusIsLost()) return;
    if (!target.hasAttribute('tabindex')) {
      target.tabIndex = -1;
      target.addEventListener(
        'blur',
        () => {
          target.removeAttribute('tabindex');
        },
        { once: true },
      );
    }
    target.focus({ preventScroll: true });
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  private readonly retry = (): void => {
    this.returnTo = this.fallback.current?.parentElement ?? null;
    this.reset();
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const { area, onClose, compact } = this.props;
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
      <div
        ref={this.fallback}
        tabIndex={-1}
        className={compact ? `${styles.fallback} ${styles.compact}` : styles.fallback}
        role="alert"
        data-snowdrop="area-error"
      >
        <p className={styles.message}>{message}</p>
        <Button size="sm" onClick={this.retry}>
          Try again
        </Button>
      </div>
    );
  }
}
