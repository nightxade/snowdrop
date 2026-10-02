import { RotateCcw, TriangleAlert } from 'lucide-react';
import { ACCENT_PRESETS, contrastRatio, deriveAccentTokens, findTheme } from '@/core/themes';
import { Button, ColorField, Segmented, Slider, Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { ThemeCards, useAllThemes } from '../themes/ThemeCards';
import { useSettingsSection } from '../useSettingsSection';
import { AppearancePreview } from './AppearancePreview';

/** Text-on-accent contrast for a custom accent (the engine picks the better of dark/white). */
export function accentContrast(accent: string, kind: 'dark' | 'light'): number {
  const on = deriveAccentTokens(accent, kind)['text-on-accent'];
  return on ? contrastRatio(accent, on) : 21;
}

export function AppearancePage() {
  const [a, set] = useSettingsSection('appearance');
  const { custom } = useAllThemes();
  const theme = findTheme(a.themeId, custom);
  const ratio = a.accent ? accentContrast(a.accent, theme.kind) : null;
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
            ratio !== null && ratio < 4.5 ? (
              <>
                <TriangleAlert size={14} aria-hidden />
                Text on this colour has a contrast of {ratio.toFixed(1)}:1 (4.5:1 is the minimum for
                readable text). Pick a deeper or brighter shade.
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
      <SettingsSection id="layout" title="Messages">
        <SettingRow
          id="appearance.density"
          label="Message density"
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
          id="appearance.clock"
          label="Time format"
          control={
            <Segmented
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
          }
        />
      </SettingsSection>
      <SettingsSection id="text" title="Size">
        <SettingRow
          id="appearance.fontScale"
          label="Text size"
          description="Scales message and interface text."
          control={
            <Slider
              aria-label="Text size"
              value={Math.round(a.fontScale * 1000) / 10}
              min={87.5}
              max={125}
              step={2.5}
              format={(v) => `${Math.round(v)}%`}
              onValueChange={(v) => {
                set({ fontScale: v / 100 });
              }}
            />
          }
        />
        <SettingRow
          id="appearance.zoom"
          label="Zoom"
          description="Scales everything, like browser zoom."
          control={
            <Slider
              aria-label="Zoom"
              value={Math.round(a.zoom * 100)}
              min={80}
              max={150}
              step={5}
              format={(v) => `${v}%`}
              onValueChange={(v) => {
                set({ zoom: v / 100 });
              }}
            />
          }
        />
      </SettingsSection>
    </>
  );
}
