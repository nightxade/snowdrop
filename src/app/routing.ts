import type { SessionPhase } from '@/core/stores';

/** The screens the root chooses between. */
export type Screen = 'welcome' | 'connection-setup' | 'shell';

/** Why the connection setup screen is up (its copy and steps differ). */
export type SetupReason = 'no-account' | 'account-required' | 'not-installed';

export interface RouteInputs {
  /** Whether a backend has been chosen at all (first run has not). */
  chosen: boolean;
  /** Whether the chosen backend is the running instance's. */
  matches: boolean;
  backend: string;
  /** The desktop app, which can install signal-cli itself. */
  desktop: boolean;
}

/**
 * The setup step a session phase asks for, or null when the shell should show.
 * Exhaustive over `SessionPhase`, so a new phase is a compile error here
 * rather than a missing screen. `not-installed` is a setup step only where
 * Snowdrop can install signal-cli (the desktop app); elsewhere the shell's
 * connection banner carries the failure.
 */
export function setupReasonFor(phase: SessionPhase, desktop: boolean): SetupReason | null {
  switch (phase) {
    case 'needs-link':
      return 'no-account';
    case 'needs-account':
      return 'account-required';
    case 'not-installed':
      return desktop ? 'not-installed' : null;
    case 'idle':
    case 'connecting':
    case 'ready':
    case 'degraded':
    case 'failed':
      return null;
  }
}

/** Which screen the app root shows for a session phase. */
export function screenFor(phase: SessionPhase, inputs: RouteInputs): Screen {
  if (!inputs.chosen) return 'welcome';
  if (!inputs.matches || inputs.backend !== 'signal-cli') return 'shell';
  return setupReasonFor(phase, inputs.desktop) === null ? 'shell' : 'connection-setup';
}
