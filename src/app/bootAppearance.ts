/**
 * Themes the pre-unlock screens (setup/unlock/unavailable) from
 * `APPEARANCE_BOOT_KEY` — the plaintext `{ themeId, density }` mirror kept
 * for exactly this (docs/ENCRYPTION.md, "Web cache"; `core/persistence/
 * hydratedKeyValue.ts`) — so they paint in the user's theme instead of
 * flashing the default one while the vault is still locked.
 */
import { APPEARANCE_BOOT_KEY, defaultStorage } from '@/core/persistence';
import { defaultSettings } from '@/core/stores';
import { applyAppearance, type ThemeDocument } from '@/core/themes';

export function applyBootAppearance(document: ThemeDocument): void {
  const settings = defaultSettings();
  const defaults = settings.appearance;
  let boot: { themeId: string; density: string; shell: string } = defaults;
  try {
    const raw = defaultStorage().getItem(APPEARANCE_BOOT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { themeId?: unknown; density?: unknown; shell?: unknown };
      boot = {
        themeId: typeof parsed.themeId === 'string' ? parsed.themeId : defaults.themeId,
        density: typeof parsed.density === 'string' ? parsed.density : defaults.density,
        shell: typeof parsed.shell === 'string' ? parsed.shell : defaults.shell,
      };
    }
  } catch {
    // Malformed boot mirror: fall back to defaults rather than block the screen.
    boot = defaults;
  }
  applyAppearance(document, {
    ...defaults,
    customCss: settings.customCss,
    themeId: boot.themeId,
    density: boot.density === 'compact' ? 'compact' : 'comfortable',
    shell: boot.shell === 'tui' ? 'tui' : 'standard',
  });
}
