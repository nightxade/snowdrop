/**
 * A render error in one area of the shell shows that area's fallback and
 * leaves the rest of the shell standing (the root boundary is not involved:
 * these render AppShell directly, with no AppErrorBoundary above it).
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { AppShell } from './AppShell';

const broken = vi.hoisted(() => ({ sidebar: false }));

vi.mock('@/ui/features/sidebar', () => ({
  Sidebar: () => {
    if (broken.sidebar) throw new Error('sidebar boom');
    return <nav aria-label="Stub conversations">stub sidebar</nav>;
  },
}));
vi.mock('@/ui/features/chat', () => ({
  ChatColumn: () => {
    return <main aria-label="Stub chat">stub chat</main>;
  },
}));

const live: Snowdrop[] = [];
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  broken.sidebar = false;
  cleanup();
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
});

async function mount() {
  const snowdrop = await bootSnowdrop();
  live.push(snowdrop);
  renderWithSnowdrop(snowdrop, <AppShell />);
  await settle(snowdrop);
}

describe('AppShell areas', () => {
  it('a crashing sidebar leaves the chat standing, and Try again recovers', async () => {
    broken.sidebar = true;
    await mount();
    expect(screen.getByRole('alert').textContent).toContain('the conversation list');
    expect(screen.getByText('stub chat')).toBeTruthy();
    broken.sidebar = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('stub sidebar')).toBeTruthy();
  });
});
