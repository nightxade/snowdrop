import { describe, expect, it } from 'vitest';
import type { SessionPhase } from '@/core/stores';
import { screenFor, setupReasonFor, type RouteInputs, type Screen } from './routing';

const PHASES: SessionPhase[] = [
  'idle',
  'connecting',
  'needs-link',
  'needs-account',
  'not-installed',
  'ready',
  'degraded',
  'failed',
];

const base: RouteInputs = { chosen: true, matches: true, backend: 'signal-cli', desktop: true };

/** phase -> [screen in the desktop app, screen in the browser] for a chosen, running signal-cli. */
const EXPECTED: Record<SessionPhase, [Screen, Screen]> = {
  idle: ['shell', 'shell'],
  connecting: ['shell', 'shell'],
  'needs-link': ['connection-setup', 'connection-setup'],
  'needs-account': ['connection-setup', 'connection-setup'],
  // Only the desktop app can install signal-cli itself.
  'not-installed': ['connection-setup', 'shell'],
  ready: ['shell', 'shell'],
  degraded: ['shell', 'shell'],
  failed: ['shell', 'shell'],
};

describe('app routing: phase x screen', () => {
  it('covers every phase', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PHASES].sort());
  });

  it.each(PHASES)('signal-cli, %s', (phase) => {
    const [desktop, browser] = EXPECTED[phase];
    expect(screenFor(phase, base)).toBe(desktop);
    expect(screenFor(phase, { ...base, desktop: false })).toBe(browser);
  });

  it.each(PHASES)('no choice yet is the welcome screen, whatever the phase (%s)', (phase) => {
    expect(screenFor(phase, { ...base, chosen: false })).toBe('welcome');
  });

  it.each(PHASES)('a choice the running backend does not match shows the shell (%s)', (phase) => {
    expect(screenFor(phase, { ...base, matches: false })).toBe('shell');
  });

  it.each(PHASES)('the demo backend never shows setup (%s)', (phase) => {
    expect(screenFor(phase, { ...base, backend: 'mock' })).toBe('shell');
  });

  it('names the setup step each phase asks for', () => {
    expect(setupReasonFor('needs-link', false)).toBe('no-account');
    expect(setupReasonFor('needs-account', false)).toBe('account-required');
    expect(setupReasonFor('not-installed', true)).toBe('not-installed');
    expect(setupReasonFor('not-installed', false)).toBeNull();
    expect(setupReasonFor('ready', true)).toBeNull();
  });
});
