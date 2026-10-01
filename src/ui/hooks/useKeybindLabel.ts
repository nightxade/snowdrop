import { useStore } from 'zustand';
import { formatKeybind, isMacPlatform, parseKeybind } from '@/core/commands';
import { useShrike } from './ShrikeContext';

/** Platform-formatted effective keybind of a command ("Ctrl+K" / "⌘K"), honouring overrides. */
export function useKeybindLabel(commandId: string): string | undefined {
  const { stores, commands } = useShrike();
  const override = useStore(stores.settings, (s) => s.keybinds[commandId]);
  const source = override ?? commands.get(commandId)?.keybind;
  const kb = source ? parseKeybind(source) : null;
  return kb ? formatKeybind(kb, isMacPlatform()) : undefined;
}
