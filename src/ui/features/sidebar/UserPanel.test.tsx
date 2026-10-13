/**
 * The sidebar footer's identity row, including HistoryImportService's
 * unobtrusive "Importing message history… N%" indicator (see
 * `HistoryImportService`'s doc comment for how that status is produced).
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { UserPanel } from './UserPanel';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('UserPanel', () => {
  it('shows the normal subtitle when nothing is importing', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <UserPanel />);

    expect(screen.getByText('Demo account')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows an unobtrusive progress indicator while importing', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <UserPanel />);

    act(() => {
      snowdrop?.stores.session
        .getState()
        .setHistoryImport({ status: 'importing', percent: 42, imported: 100, error: null });
    });

    expect(screen.getByText('Importing message history… 42%')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Importing message history' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
  });

  it('goes back to the normal subtitle once the import finishes', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <UserPanel />);

    act(() => {
      snowdrop?.stores.session
        .getState()
        .setHistoryImport({ status: 'importing', percent: 50, imported: 50, error: null });
    });
    expect(screen.queryByRole('progressbar')).not.toBeNull();

    act(() => {
      snowdrop?.stores.session
        .getState()
        .setHistoryImport({ status: 'done', percent: 100, imported: 120, error: null });
    });

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Demo account')).toBeTruthy();
  });
});
