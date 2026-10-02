import { useStore } from 'zustand';
import {
  coerceSetting,
  resolveSettings,
  type PluginDefinition,
  type SettingDefinition,
} from '@/core/plugins';
import { useStores } from '@/ui/hooks';
import { Segmented, Select, Slider, Switch, TextInput } from '@/ui/primitives';
import { SettingRow, type ControlIds } from '../rows/SettingRow';
import { SettingsFilterProvider } from '../rows/SettingsFilter';
import styles from './plugins.module.css';

/**
 * Form generated from a plugin's settings schema. Each field is a regular
 * SettingRow; values are coerced through the schema and saved on change
 * (no Save button), exactly like the app's own settings.
 */
export function PluginSettingsForm({ plugin }: { plugin: PluginDefinition }) {
  const stores = useStores();
  const stored = useStore(stores.settings, (s) => s.plugins[plugin.id]?.settings);
  const schema = plugin.settings ?? {};
  const values = resolveSettings(schema, stored ?? {});
  const set = (key: string, def: SettingDefinition, value: unknown) => {
    stores.settings.getState().setPluginSetting(plugin.id, key, coerceSetting(def, value));
  };
  const entries = Object.entries(schema).filter(([, def]) => !def.hidden);
  if (entries.length === 0)
    return <p className={styles.noSettings}>This plugin has no settings.</p>;
  return (
    // The form is outside page search; never filter it.
    <SettingsFilterProvider value={null}>
      <div className={styles.form}>
        {entries.map(([key, def]) => (
          <SettingRow
            key={key}
            id={`plugin.${plugin.id}.${key}`}
            label={def.label}
            {...(def.description ? { description: def.description } : {})}
            stacked={def.type === 'string'}
            control={(ids) =>
              fieldFor(
                def,
                values[key],
                (v) => {
                  set(key, def, v);
                },
                ids,
              )
            }
          />
        ))}
      </div>
    </SettingsFilterProvider>
  );
}

/** The control for one schema field (exported for tests). */
export function fieldFor(
  def: SettingDefinition,
  value: unknown,
  onChange: (value: unknown) => void,
  ids: ControlIds,
) {
  const described = ids.descriptionId;
  switch (def.type) {
    case 'boolean':
      return (
        <Switch
          id={ids.id}
          aria-describedby={described}
          checked={value === true}
          onCheckedChange={onChange}
        />
      );
    case 'number':
      if (def.min !== undefined && def.max !== undefined)
        return (
          <Slider
            id={ids.id}
            aria-describedby={described}
            value={typeof value === 'number' ? value : def.default}
            min={def.min}
            max={def.max}
            step={def.step ?? 1}
            onValueChange={onChange}
          />
        );
      return (
        <TextInput
          id={ids.id}
          aria-describedby={described}
          type="number"
          size="sm"
          className={styles.number}
          value={String(value)}
          {...(def.min !== undefined ? { min: def.min } : {})}
          {...(def.max !== undefined ? { max: def.max } : {})}
          {...(def.step !== undefined ? { step: def.step } : {})}
          onChange={(e) => {
            if (e.target.value !== '') onChange(Number(e.target.value));
          }}
        />
      );
    case 'select':
      return def.options.length <= 3 ? (
        <Segmented
          label={def.label}
          value={typeof value === 'string' ? value : def.default}
          options={def.options}
          onValueChange={onChange}
        />
      ) : (
        <Select
          id={ids.id}
          aria-describedby={described}
          value={typeof value === 'string' ? value : def.default}
          options={def.options}
          onValueChange={onChange}
        />
      );
    case 'string':
      return def.multiline ? (
        <textarea
          id={ids.id}
          aria-describedby={described}
          className={styles.textarea}
          value={typeof value === 'string' ? value : ''}
          placeholder={def.placeholder}
          maxLength={def.maxLength}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      ) : (
        <TextInput
          id={ids.id}
          aria-describedby={described}
          className={styles.text}
          value={typeof value === 'string' ? value : ''}
          placeholder={def.placeholder}
          maxLength={def.maxLength}
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      );
  }
}
