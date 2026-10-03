/** Vim Mode's settings schema (eager: the plugin card's form needs it before the plugin starts). */
import { defineSettings } from '@/core/plugins';

export const LEADER_OPTIONS = [
  { value: ' ', label: 'Space' },
  { value: ',', label: 'Comma (,)' },
  { value: '\\', label: 'Backslash (\\)' },
  { value: ';', label: 'Semicolon (;)' },
] as const;

export const settings = defineSettings({
  navigation: {
    type: 'boolean',
    label: 'Navigation keys',
    description: 'j/k, gg/G, J/K, ]u, gt and message actions when you aren’t typing.',
    default: true,
  },
  composer: {
    type: 'boolean',
    label: 'Modal editing in the composer',
    description: 'Normal, Insert and Visual modes in the message box.',
    default: true,
  },
  startInInsert: {
    type: 'boolean',
    label: 'Start the composer in Insert mode',
    description: 'Type straight away; Esc switches to Normal mode.',
    default: true,
  },
  leader: {
    type: 'select',
    label: 'Leader key',
    description: 'Press it, then s for settings, k switcher, n notifications, p plugins.',
    default: ' ',
    options: LEADER_OPTIONS,
  },
  timeout: {
    type: 'number',
    label: 'Key sequence timeout (ms)',
    description: 'How long to wait for the next key of gg, ]u, the leader…',
    default: 1000,
    min: 300,
    max: 3000,
    step: 100,
  },
  introShown: { type: 'boolean', label: 'Intro toast shown', default: false, hidden: true },
});
