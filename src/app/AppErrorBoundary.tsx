/**
 * Catches a render error anywhere below it, so one broken component can no
 * longer blank the whole window (there was no error boundary before this).
 * `src/main.tsx` wraps both trees with it: the desktop StorageGate tree and
 * the browser tree. A rejected `lazy()` import throws the same way during
 * render, so it lands here too — no lazy-specific handling needed, as long
 * as this sits above every `<Suspense>` boundary (it does: it wraps the
 * whole root).
 *
 * Reporting: `componentDidCatch` is the one place this error reaches the
 * terminal, via the same `report` function `installTerminalErrorLog`
 * (platform.ts) returns and `onUncaughtError` already uses in main.tsx.
 * React also has a built-in default (console.error) for errors an error
 * boundary catches, which would otherwise report the same error a second
 * time — main.tsx sets the root's `onCaughtError` to a no-op to silence
 * that default, so this stays the single report per error.
 */
import { Copy, RotateCw } from 'lucide-react';
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createLogger, recentLogLines } from '@/core/lib';
import { OnboardingShell } from '@/ui/features/onboarding/OnboardingShell';
import setupStyles from '@/ui/features/onboarding/Setup.module.css';
import storageStyles from '@/ui/features/onboarding/Storage.module.css';
import { Button } from '@/ui/primitives';
import stackStyles from './AppErrorBoundary.module.css';
import { desktopLogAdmin, isTauri } from './platform';

/** Last ~40 lines appended to "Copy details" — enough context without being unwieldy. */
const LOG_TAIL_LINES = 40;

/**
 * Best-effort, failure-tolerant: the desktop log (`log_recent`) first, since
 * it has every source (Rust and frontend); the in-memory ring buffer
 * (`src/core/lib/log.ts`) as a fallback, which is always available (even in
 * the browser build, and even if the Tauri call itself fails).
 */
async function recentLogTail(maxLines: number): Promise<string[]> {
  if (isTauri()) {
    try {
      const text = await desktopLogAdmin().recent(65536);
      const lines = text.split('\n').filter((line) => line.length > 0);
      if (lines.length > 0) return lines.slice(-maxLines);
    } catch {
      // Fall through to the ring buffer below.
    }
  }
  return [...recentLogLines()].slice(-maxLines);
}

export interface AppErrorBoundaryProps {
  children: ReactNode;
  /**
   * Reports the caught error to the terminal. Defaults to the scoped
   * logger at scope `app` (still fine standalone: `installTerminalErrorLog`
   * just wires the same logger up to the desktop app's own log too).
   */
  report?: (error: unknown, where: string) => void;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function detailsText(error: Error): string {
  return `${error.message}\n\n${error.stack ?? ''}`.trim();
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: toError(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const report =
      this.props.report ??
      ((e: unknown, where: string) => {
        createLogger('app').error(where, e);
      });
    report(error, `caught render error${info.componentStack ?? ''}`);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) return <ErrorFallback error={error} />;
    return this.props.children;
  }
}

function ErrorFallback({ error }: { error: Error }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);

  // A fallback appearing out of nowhere needs focus moved to it deliberately
  // (role="alert" alone announces it, but doesn't move keyboard focus).
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const copy = async () => {
    let text = detailsText(error);
    try {
      const lines = await recentLogTail(LOG_TAIL_LINES);
      if (lines.length > 0) text += `\n\n--- recent log ---\n${lines.join('\n')}`;
    } catch {
      // Best effort: the error details alone are still worth copying.
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access denied or unavailable; nothing more to do about it.
    }
  };

  return (
    <OnboardingShell>
      <section
        className={setupStyles.card}
        role="alert"
        aria-labelledby="app-error-title"
        data-snowdrop="app-error"
      >
        <h2 id="app-error-title" ref={headingRef} tabIndex={-1} className={setupStyles.title}>
          Something went wrong
        </h2>
        <p className={setupStyles.lede}>
          Snowdrop hit an unexpected error. Your data is safe — reloading usually clears it up.
        </p>
        <details className={storageStyles.disclosure}>
          <summary>Details</summary>
          <p>{error.message}</p>
          {error.stack && <pre className={stackStyles.stack}>{error.stack}</pre>}
        </details>
        <div className={setupStyles.actions}>
          <Button
            type="button"
            variant="primary"
            icon={<RotateCw size={16} />}
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload
          </Button>
          <Button
            type="button"
            variant="ghost"
            icon={<Copy size={16} />}
            onClick={() => void copy()}
          >
            Copy details
          </Button>
        </div>
        {copied && (
          <p className={setupStyles.muted} role="status">
            Copied.
          </p>
        )}
      </section>
    </OnboardingShell>
  );
}
