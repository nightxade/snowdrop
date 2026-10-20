/**
 * Startup phase timing: each phase is marked once, with its elapsed time
 * since the page's time origin (`performance.now()`), so the desktop app's
 * log can lay the frontend's boot next to the Rust side's own phases. Names
 * and milliseconds only — never any data. Marks made before a sink exists
 * (the earliest ones run before the log bridge is installed) are replayed to
 * it when it arrives.
 */
export type StartupSink = (name: string, elapsedMs: number) => void;

const marks = new Map<string, number>();
let sink: StartupSink | null = null;

/** Records a phase the first time it's reached; later calls with the same name do nothing. */
export function markStartup(name: string): void {
  if (marks.has(name)) return;
  const elapsed = Math.round(performance.now());
  marks.set(name, elapsed);
  sink?.(name, elapsed);
}

/** Routes marks to `next` (replaying the ones already made); `null` stops routing. */
export function setStartupSink(next: StartupSink | null): void {
  sink = next;
  if (next) for (const [name, elapsed] of marks) next(name, elapsed);
}

/** Test seam: forgets every mark and the sink. */
export function resetStartupMarks(): void {
  marks.clear();
  sink = null;
}
