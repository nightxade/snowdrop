import { useMediaQuery } from '@/ui/hooks';
import { Segmented, Slider, Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';

export function AccessibilityPage() {
  const [a, set] = useSettingsSection('appearance');
  const systemReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  return (
    <SettingsSection>
      <SettingRow
        id="a11y.motion"
        label="Reduce motion"
        description={`Turns off animations and transitions. Your system currently ${systemReduced ? 'asks for reduced motion' : 'allows motion'}.`}
        control={(ids) => (
          <Segmented
            labelledBy={ids.labelId}
            label="Reduce motion"
            value={a.reducedMotion}
            options={[
              { value: 'system', label: 'System' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onValueChange={(v) => {
              set({ reducedMotion: v });
            }}
          />
        )}
      />
      <SettingRow
        id="a11y.focus"
        label="High-contrast focus outline"
        description="A thicker outline in the strongest text colour, ringed with the background, so keyboard focus is easy to find on any surface."
        control={(ids) => (
          <Switch
            id={ids.id}
            aria-describedby={ids.descriptionId}
            checked={a.strongFocus}
            onCheckedChange={(v) => {
              set({ strongFocus: v });
            }}
          />
        )}
      />
      <SettingRow
        id="a11y.targets"
        label="Larger click targets"
        description="Conversation rows, member rows and icon buttons grow to at least 36–44px."
        control={(ids) => (
          <Switch
            id={ids.id}
            aria-describedby={ids.descriptionId}
            checked={a.largeTargets}
            onCheckedChange={(v) => {
              set({ largeTargets: v });
            }}
          />
        )}
      />
      <SettingRow
        id="a11y.saturation"
        label="Saturation"
        description="Tones down colour across the app, avatars and accent included."
        control={(ids) => (
          <Slider
            id={ids.id}
            aria-describedby={ids.descriptionId}
            value={Math.round(a.saturation * 100)}
            min={0}
            max={100}
            step={5}
            format={(v) => `${v}%`}
            onValueChange={(v) => {
              set({ saturation: v / 100 });
            }}
          />
        )}
      />
    </SettingsSection>
  );
}
