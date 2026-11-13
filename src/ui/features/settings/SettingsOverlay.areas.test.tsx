/** A crashing settings page shows the fallback in the content area; the nav and search stay. */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { SettingsOverlay } from './SettingsOverlay';

const broken = vi.hoisted(() => ({ on: true }));
vi.mock('./SettingsPage', () => ({
  SettingsPage: ({ id }: { id: string }) => {
    if (broken.on) throw new Error('page boom');
    return <p>page {id}</p>;
  },
}));

const live: Snowdrop[] = [];
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  broken.on = true;
  cleanup();
  vi.restoreAllMocks();
  for (const s of live.splice(0)) await s.dispose();
});

describe('SettingsOverlay areas', () => {
  it('contains a page crash, and Try again recovers', async () => {
    const snowdrop = await bootSnowdrop();
    live.push(snowdrop);
    const onClose = vi.fn();
    renderWithSnowdrop(snowdrop, <SettingsOverlay onClose={onClose} initialPage="privacy" />);
    await settle(snowdrop);
    expect(screen.getByRole('alert').textContent).toContain('this page');
    expect(screen.getByRole('searchbox')).toBeTruthy();
    broken.on = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('page privacy')).toBeTruthy();
  });
});
