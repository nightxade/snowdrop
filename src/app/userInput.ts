/**
 * When the user last pressed a key or a pointer button anywhere in the window. A dialog that opens
 * by itself, late (a failed send's safety-number review), asks this first: opening it while the
 * user is typing or clicking would take focus away from what they are doing.
 */
export interface UserInput {
  /** Whether the user has pressed a key or a pointer button after `at` (a clock reading). */
  since(at: number): boolean;
  stop(): void;
}

interface EventTarget {
  addEventListener(type: string, listener: () => void, options: boolean): void;
  removeEventListener(type: string, listener: () => void, options: boolean): void;
}

const EVENTS = ['keydown', 'pointerdown'] as const;

export function trackUserInput(
  clock: { now(): number },
  target: EventTarget | undefined = typeof window === 'undefined' ? undefined : window,
): UserInput {
  let last = Number.NEGATIVE_INFINITY;
  const note = (): void => {
    last = clock.now();
  };
  for (const type of EVENTS) target?.addEventListener(type, note, true);
  return {
    since: (at) => last > at,
    stop: () => {
      for (const type of EVENTS) target?.removeEventListener(type, note, true);
    },
  };
}
