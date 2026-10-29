import type { ErrorReporter } from './types';

/**
 * When in a successful connect a step runs. `before-live` steps run once the
 * initial sync has succeeded but before the first live event is let through
 * (so a listener such as notifications can't miss one); `after-ready` steps
 * run once the session is ready.
 */
export type PostConnectStage = 'before-live' | 'after-ready';

/** What SyncService needs from the owner of the post-connect steps. */
export interface PostConnectRunner {
  run(stage: PostConnectStage): Promise<void>;
  /**
   * The connection was ended (`SyncService.stop()`): forget which steps are
   * done, so the next connect runs them again, and let a run still going
   * stop after the step it is on.
   */
  reset(): void;
}

interface Step {
  name: string;
  stage: PostConnectStage;
  run: () => void | Promise<void>;
}

/**
 * The one owner of what must happen after the backend connects: the steps the
 * app wires up once there is a session (history import, outbox restore,
 * plugins, notifications, ...).
 *
 * SyncService runs every stage after *any* successful connect (the first, one
 * recovered by Retry or by its own timer, or a reconnect), so no recovery path
 * can skip them. A step that has succeeded is not run again (they are things
 * to start once per session); one that threw stays pending and is tried again
 * after the next successful connect, and `reset()` (a disconnect) makes every
 * step due again. Steps are isolated: a failing step is
 * reported and never stops the others, nor fails the connect.
 */
export class PostConnect implements PostConnectRunner {
  private readonly steps: Step[] = [];
  private readonly done = new Set<Step>();
  /** Bumped by `reset()`; a run from an earlier one stops and records nothing. */
  private epoch = 0;

  constructor(private readonly onError: ErrorReporter) {}

  /** Registers a step; steps of a stage run in registration order. */
  add(stage: PostConnectStage, name: string, run: () => void | Promise<void>): void {
    this.steps.push({ name, stage, run });
  }

  reset(): void {
    this.epoch++;
    this.done.clear();
  }

  async run(stage: PostConnectStage): Promise<void> {
    const epoch = this.epoch;
    for (const step of this.steps) {
      if (epoch !== this.epoch) return;
      if (step.stage !== stage || this.done.has(step)) continue;
      try {
        await step.run();
        if (epoch === this.epoch) this.done.add(step);
      } catch (error) {
        if (epoch === this.epoch) this.onError(error, `post-connect step "${step.name}" failed`);
      }
    }
  }
}
