import { RotateCcw, TriangleAlert } from 'lucide-react';
import {
  accentContext,
  ACCENT_PRESETS,
  contrastRatio,
  deriveAccentTokens,
  findTheme,
} from '@/core/themes';
import { Button, ColorField, Segmented, Slider, Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { ThemeCards, useAllThemes } from '../themes/ThemeCards';
import { useSettingsSection } from '../useSettingsSection';
import { AppearancePreview } from './AppearancePreview';

/** Text-on-accent contrast for a custom accent (the engine picks the better of dark/white). */
function accentContrast(accent: string, kind: 'dark' | 'light'): number {
  const on = deriveAccentTokens(accent, kind)['text-on-accent'];
  return on ? contrastRatio(accent, on) : 21;
}

export function AppearancePage() {
  const [a, set] = useSettingsSection('appearance');
  const { custom } = useAllThemes();
  const theme = findTheme(a.themeId, custom);
  const ratio = a.accent ? accentContrast(a.accent, theme.kind) : null;
  // Against the chat background (buttons, rings, the mention bar): 3:1 for non-text UI.
  const { accent, background } = accentContext(theme, a.accent);
  const surface = a.accent ? contrastRatio(accent, background) : null;
  return (
    <>
      <SettingsSection id="theme">
        <SettingRow
          id="appearance.theme"
          label="Theme"
          stacked
          control={<ThemeCards label="Theme" />}
        />
        <SettingRow
          id="appearance.accent"
          label="Accent colour"
          description="Used for selection, buttons and your mentions. Hover and pressed shades are derived from it."
          stacked
          control={
            <div>
              <ColorField
                label="Accent colour"
                value={a.accent ?? theme.preview[3]}
                presets={ACCENT_PRESETS}
                onValueChange={(accent) => {
                  set({ accent });
                }}
              />
            </div>
          }
          note={
            (ratio !== null && ratio < 4.5) || (surface !== null && surface < 3) ? (
              <>
                <TriangleAlert size={14} aria-hidden />
                <span>
                  {ratio !== null && ratio < 4.5 && (
                    <>
                      Text on this colour has a contrast of {ratio.toFixed(1)}:1 (readable text
                      needs 4.5:1).{' '}
                    </>
                  )}
                  {surface !== null && surface < 3 && (
                    <>
                      It stands out only {surface.toFixed(1)}:1 from the {theme.name} background
                      (buttons and rings need 3:1).{' '}
                    </>
                  )}
                  Pick a deeper or brighter shade. Accent-coloured text is adjusted automatically to
                  stay readable.
                </span>
              </>
            ) : undefined
          }
          noteTone="warning"
        >
          {a.accent && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={14} />}
              onClick={() => {
                set({ accent: null });
              }}
            >
              Use {theme.name}’s accent
            </Button>
          )}
        </SettingRow>
      </SettingsSection>
      <SettingsSection id="shell" title="Layout">
        <SettingRow
          id="appearance.shell"
          label="Layout"
          description="TUI boxes every region with a titled border, monospace type and a status line. Colours and theme are unchanged."
          control={(ids) => (
            <Segmented
              labelledBy={ids.labelId}
              label="Layout"
              value={a.shell}
              options={[
                { value: 'standard', label: 'Standard' },
                { value: 'tui', label: 'TUI' },
              ]}
              onValueChange={(shell) => {
                set({ shell });
              }}
            />
          )}
        />
      </SettingsSection>
      <SettingsSection id="layout" title="Messages">
        <SettingRow
          id="appearance.density"
          label="Message density"
          description={
            a.shell === 'tui' ? 'TUI always shows messages one line per row.' : undefined
          }
          stacked
          control={<AppearancePreview />}
        >
          <Segmented
            label="Message density"
            value={a.density}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
            onValueChange={(density) => {
              set({ density });
            }}
          />
        </SettingRow>
        <SettingRow
          id="appearance.compactAvatars"
          label="Show avatars in compact mode"
          description={
            a.density === 'compact'
              ? 'Small avatars before each name.'
              : 'Applies when density is compact.'
          }
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={a.showAvatarsInCompact}
              onCheckedChange={(v) => {
                set({ showAvatarsInCompact: v });
              }}
            />
          )}
        />
        <SettingRow
          id="appearance.splitHome"
          label="Separate groups and direct messages"
          description="Home lists them in two sections instead of one, most recent first."
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={a.splitHomeByType}
              onCheckedChange={(v) => {
                set({ splitHomeByType: v });
              }}
            />
          )}
        />
        <SettingRow
          id="appearance.clock"
          label="Time format"
          control={(ids) => (
            <Segmented
              labelledBy={ids.labelId}
              label="Time format"
              value={a.clock24h ? '24' : '12'}
              options={[
                { value: '12', label: '12-hour' },
                { value: '24', label: '24-hour' },
              ]}
              onValueChange={(v) => {
                set({ clock24h: v === '24' });
              }}
            />
          )}
        />
      </SettingsSection>
      <SettingsSection id="text" title="Size">
        <SettingRow
          id="appearance.fontScale"
          label="Text size"
          description="Scales message and interface text."
          control={(ids) => (
            <Slider
              id={ids.id}
              aria-describedby={ids.descriptionId}
              value={Math.round(a.fontScale * 1000) / 10}
              min={87.5}
              max={125}
              step={2.5}
              format={(v) => `${Number.isInteger(v) ? v : v.toFixed(1)}%`}
              onValueChange={(v) => {
                set({ fontScale: v / 100 });
              }}
            />
          )}
        />
        <SettingRow
          id="appearance.zoom"
          label="Zoom"
          description="Scales everything, like browser zoom."
          control={(ids) => (
            <Slider
              id={ids.id}
              aria-describedby={ids.descriptionId}
              value={Math.round(a.zoom * 100)}
              min={80}
              max={150}
              step={5}
              format={(v) => `${v}%`}
              onValueChange={(v) => {
                set({ zoom: v / 100 });
              }}
            />
          )}
        />
      </SettingsSection>
    </>
  );
}
