/**
 * Built-ins whose value is mostly visual. Their definitions (and settings)
 * exist now so settings/persistence are stable; the UI parts land in P4.
 */
import { definePlugin } from '../types';
import { defineSettings } from '../settings';

export const relativeTimestampsPlugin = definePlugin({
  id: 'relative-timestamps',
  name: 'Relative Timestamps',
  description: 'Shows "3m ago" style times next to messages.',
  authors: ['shrike'],
  tags: ['appearance', 'messages'],
  preview: true,
  settings: defineSettings({
    mode: {
      type: 'select',
      label: 'Display',
      default: 'relative',
      options: [
        { value: 'relative', label: 'Relative only' },
        { value: 'both', label: 'Relative and absolute' },
      ],
    },
  }),
  start() {
    // TODO(P4): register a message decoration rendering formatRelative().
  },
});

export const messageToolsPlugin = definePlugin({
  id: 'message-tools',
  name: 'Message Tools',
  description: 'Adds "Copy as Markdown" and a word count to the message hover bar.',
  authors: ['shrike'],
  tags: ['messages'],
  preview: true,
  start() {
    // TODO(P4): hover actions (need icon components from ui/).
  },
});
