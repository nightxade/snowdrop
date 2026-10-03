import type { MenuItem, Registries } from '@/core/plugins';
import { isRenderableComponent, type MenuEntry } from '@/ui/primitives';

const ICON = 16;

/**
 * Turns the plugin items registered for a menu location (`ctx.menus.add`)
 * into menu entries for `target`: hides items whose `visible` says no (or
 * throws), renders their icon, and reports a failing `onSelect` (sync throw
 * or rejected promise) without breaking the menu. Failures go to
 * `registries` (the plugin's card shows them) when given, else the console.
 */
export function pluginMenuEntries<T>(
  items: readonly (MenuItem<T> & { owner: string })[],
  target: T,
  registries?: Pick<Registries, 'invoke' | 'isVisible'>,
): MenuEntry[] {
  return items
    .filter((item) => {
      if (registries) return registries.isVisible(item, target, 'menu item');
      try {
        return item.visible?.(target) ?? true;
      } catch {
        return false;
      }
    })
    .map((item): MenuEntry => {
      const Icon = isRenderableComponent<{ size?: number }>(item.icon) ? item.icon : null;
      const report = (error: unknown) => {
        console.error(`[snowdrop] plugin "${item.owner}" menu item failed`, error);
      };
      return {
        kind: 'item',
        id: `plugin:${item.owner}:${item.id}`,
        label: item.label,
        ...(Icon ? { icon: <Icon size={ICON} aria-hidden /> } : {}),
        ...(item.danger ? { danger: true } : {}),
        onSelect: () => {
          if (registries) {
            registries.invoke(item, 'menu item', () => item.onSelect(target));
            return;
          }
          try {
            const result = item.onSelect(target);
            if (result instanceof Promise) result.catch(report);
          } catch (error) {
            report(error);
          }
        },
      };
    });
}
