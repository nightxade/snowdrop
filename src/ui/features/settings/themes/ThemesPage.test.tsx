/**
 * The import trial: a theme with its own CSS applies on probation, and only
 * staying on the page and pressing Keep makes it stick.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ThemesPage } from './ThemesPage';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

const THEME = JSON.stringify({
  name: 'Trial',
  id: 'trial',
  tokens: { accent: '#ff0000' },
  css: '.x { color: red; }',
});

async function importTheme(container: HTMLElement) {
  const file = new File([THEME], 'trial.json', { type: 'application/json' });
  // jsdom's File has no text().
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(THEME) });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await Promise.resolve();
  });
  return screen.findByRole('alertdialog', { name: 'Keep this theme?' });
}

describe('ThemesPage: import trial', () => {
  it('puts a theme with CSS on probation and keeps it on Keep', async () => {
    snowdrop = await bootSnowdrop();
    const before = snowdrop.stores.settings.getState().appearance.themeId;
    const { container, unmount } = renderWithSnowdrop(snowdrop, <ThemesPage />);
    const trial = await importTheme(container);
    expect(snowdrop.stores.settings.getState().appearance.themeId).toBe('trial');
    expect((await axe(trial)).violations).toEqual([]);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    });
    unmount();
    expect(snowdrop.stores.settings.getState().appearance.themeId).toBe('trial');
    expect(before).not.toBe('trial');
  });

  it('reverts the trial when the page is left before the user kept it', async () => {
    snowdrop = await bootSnowdrop();
    const { settings } = snowdrop.stores;
    const before = settings.getState().appearance.themeId;
    const { container, unmount } = renderWithSnowdrop(snowdrop, <ThemesPage />);
    await importTheme(container);
    expect(settings.getState().customThemes.some((t) => t.id === 'trial')).toBe(true);

    unmount();

    await waitFor(() => {
      expect(settings.getState().appearance.themeId).toBe(before);
    });
    expect(settings.getState().customThemes.some((t) => t.id === 'trial')).toBe(false);
  });

  it('puts back the theme an import replaced when the page is left mid-trial', async () => {
    snowdrop = await bootSnowdrop();
    const { settings } = snowdrop.stores;
    const original = {
      id: 'trial',
      name: 'Original',
      kind: 'dark' as const,
      tokens: {},
      css: '',
    };
    settings.getState().saveCustomTheme(original);
    const before = settings.getState().appearance.themeId;
    const { container, unmount } = renderWithSnowdrop(snowdrop, <ThemesPage />);
    const file = new File([THEME], 'trial.json');
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(THEME) });
    await act(async () => {
      fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
        target: { files: [file] },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Replace/u }));
      await Promise.resolve();
    });
    await screen.findByRole('alertdialog', { name: 'Keep this theme?' });
    unmount();
    expect(settings.getState().appearance.themeId).toBe(before);
    expect(settings.getState().customThemes.find((t) => t.id === 'trial')?.name).toBe('Original');
  });
});
