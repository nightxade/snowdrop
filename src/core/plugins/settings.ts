/**
 * Typed plugin settings schemas.
 *
 * A plugin declares its settings once; the runtime derives value types for
 * `ctx.settings.get()` and the settings UI generates a form from the same
 * schema. Stored values are untrusted (hand-edited storage, older versions)
 * and are always coerced back into the schema on read.
 */

interface BaseSetting {
  label: string;
  description?: string;
}

export interface BooleanSetting extends BaseSetting {
  type: 'boolean';
  default: boolean;
}

export interface StringSetting extends BaseSetting {
  type: 'string';
  default: string;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
}

export interface NumberSetting extends BaseSetting {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface SelectSetting<V extends string = string> extends BaseSetting {
  type: 'select';
  default: V;
  options: readonly { value: V; label: string }[];
}

export type SettingDefinition = BooleanSetting | StringSetting | NumberSetting | SelectSetting;

export type SettingsSchema = Readonly<Record<string, SettingDefinition>>;

export type SettingValue<D extends SettingDefinition> = D extends BooleanSetting
  ? boolean
  : D extends NumberSetting
    ? number
    : D extends SelectSetting<infer V>
      ? V
      : string;

export type SettingsValues<S extends SettingsSchema> = { [K in keyof S]: SettingValue<S[K]> };

/** Identity helper that preserves literal types (select option values) for inference. */
export function defineSettings<const S extends SettingsSchema>(schema: S): S {
  return schema;
}

/** Returns `value` if valid for the definition, otherwise the default. */
export function coerceSetting<D extends SettingDefinition>(
  def: D,
  value: unknown,
): SettingValue<D> {
  switch (def.type) {
    case 'boolean':
      return (typeof value === 'boolean' ? value : def.default) as SettingValue<D>;
    case 'string': {
      if (typeof value !== 'string') return def.default as SettingValue<D>;
      return (
        def.maxLength === undefined ? value : value.slice(0, def.maxLength)
      ) as SettingValue<D>;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return def.default as SettingValue<D>;
      const min = def.min ?? -Infinity;
      const max = def.max ?? Infinity;
      return Math.min(max, Math.max(min, value)) as SettingValue<D>;
    }
    case 'select':
      return (
        typeof value === 'string' && def.options.some((o) => o.value === value)
          ? value
          : def.default
      ) as SettingValue<D>;
  }
}

export function resolveSettings<S extends SettingsSchema>(
  schema: S,
  stored: Readonly<Record<string, unknown>>,
): SettingsValues<S> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema)) out[key] = coerceSetting(def, stored[key]);
  return out as SettingsValues<S>;
}
