import type { ReactNode } from 'react';

/**
 * Declarative menu entries shared by context menus and dropdown menus, so
 * a feature builds one list (plus plugin items) and renders it either way.
 */
export type MenuEntry =
  | {
      kind: 'item';
      id: string;
      label: string;
      icon?: ReactNode;
      /** Right-aligned hint, e.g. a keybind. */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      kind: 'check';
      id: string;
      label: string;
      checked: boolean;
      icon?: ReactNode;
      onSelect: () => void;
    }
  | { kind: 'separator'; id: string }
  | { kind: 'label'; id: string; label: string }
  | { kind: 'submenu'; id: string; label: string; icon?: ReactNode; items: MenuEntry[] };

/** Drops leading/trailing/doubled separators left behind by conditional items. */
export function tidyMenu(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'separator' && (out.length === 0 || out.at(-1)?.kind === 'separator'))
      continue;
    out.push(entry.kind === 'submenu' ? { ...entry, items: tidyMenu(entry.items) } : entry);
  }
  while (out.at(-1)?.kind === 'separator') out.pop();
  return out;
}
