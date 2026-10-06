/**
 * A small scoped logger for app-wide diagnostics (Settings → Data & storage
 * → Diagnostics). No React or Tauri imports here — core/ stays usable
 * headless (plugins, services, tests); the composition root
 * (src/app/platform.ts) is the only place a Tauri sink gets registered, via
 * `addLogSink`.
 *
 * `createLogger('sync')` returns an object with `error`/`warn`/`info`/
 * `debug(message, detail?)`. `detail` may be an `Error` (formatted as
 * `name: message` plus its stack) or any small, already-safe value.
 *
 * PRIVACY: never pass message bodies, contact/profile names, phone numbers,
 * account ids or other raw payloads as `message` or `detail` — log lengths,
 * types and ids-as-kinds instead (e.g. `log.warn('attachment failed',
 * { count: 3 })`, not the attachment's name or url). The Rust side
 * (src-tauri/src/redact.rs) redacts common patterns as a backstop; that is
 * not a substitute for not logging the data in the first place.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** A destination for formatted log lines; registered with {@link addLogSink}. */
export interface LogSink {
  write(level: LogLevel, scope: string, message: string): void;
}

export interface Logger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

/**
 * Admin surface for Settings → Diagnostics. Implemented by the desktop
 * platform layer (src/platform/tauri); null in the browser build, where
 * there's no on-disk log or Rust-side verbose floor to control.
 */
export interface LogAdmin {
  /** Tail of the on-disk log, already redacted; `maxBytes` is capped server-side too. */
  recent(maxBytes: number): Promise<string>;
  /** Raises/lowers the running app's log floor to Debug (or back). Takes effect immediately. */
  setVerbose(verbose: boolean): Promise<void>;
  /** Opens the log folder in the system file manager. */
  openFolder(): void;
}

// ─── Ring buffer ────────────────────────────────────────────────────────────

const RING_CAPACITY = 200;
const ring: string[] = [];

function pushRing(line: string): void {
  ring.push(line);
  if (ring.length > RING_CAPACITY) ring.shift();
}

/**
 * The last ~200 formatted lines, oldest first — the browser build's stand-in
 * for a log file (there's nowhere else to keep them). Used by Settings →
 * Diagnostics ("Copy recent log") and the error screen's "Copy details".
 */
export function recentLogLines(): readonly string[] {
  return [...ring];
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatDetail(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) {
    const header = `${detail.name}: ${detail.message}`;
    return detail.stack ? `${header}\n${detail.stack}` : header;
  }
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail);
  try {
    return JSON.stringify(detail);
  } catch {
    return '[unserialisable value]';
  }
}

/** `2026-10-06T09:12:03.123Z WARN  ui:sync  message` — mirrors the Rust-side file format. */
function formatLine(level: LogLevel, scope: string, text: string): string {
  const ts = new Date().toISOString();
  return `${ts} ${level.toUpperCase().padEnd(5)} ui:${scope}  ${text}`;
}

// ─── Sinks ──────────────────────────────────────────────────────────────────

const consoleSink: LogSink = {
  write(level, scope, message) {
    const line = `[${scope}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else if (level === 'info') console.info(line);
    else console.debug(line);
  },
};

const sinks: LogSink[] = [consoleSink];

/**
 * Registers an additional sink (e.g. the desktop app's `frontend_log`
 * bridge) — console output always keeps happening alongside it, for dev
 * visibility. Returns a function that removes it again.
 */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i !== -1) sinks.splice(i, 1);
  };
}

// ─── Logger ─────────────────────────────────────────────────────────────────

/**
 * One logger per call site's scope, matching the Rust-side `ui:<scope>` log
 * target (`/[a-z0-9:-]{1,32}/`, e.g. `sync`, `send`, `storage`, `signal-cli`,
 * `plugins:<id>`, `ui`). Cheap to construct — call it once per module (or
 * per plugin id) and keep the result.
 */
export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, message: string, detail?: unknown): void => {
    const detailText = formatDetail(detail);
    const text = detailText ? `${message} ${detailText}` : message;
    pushRing(formatLine(level, scope, text));
    for (const sink of sinks) {
      try {
        sink.write(level, scope, text);
      } catch {
        // A sink must never break the call site it's logging for.
      }
    }
  };
  return {
    error: (message, detail) => {
      emit('error', message, detail);
    },
    warn: (message, detail) => {
      emit('warn', message, detail);
    },
    info: (message, detail) => {
      emit('info', message, detail);
    },
    debug: (message, detail) => {
      emit('debug', message, detail);
    },
  };
}
