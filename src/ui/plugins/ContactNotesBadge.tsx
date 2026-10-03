import { useSyncExternalStore } from 'react';
import type { Message } from '@/core/domain';
import { definePlugin, defineSettings, type PluginContext } from '@/core/plugins';
import { Tooltip } from '@/ui/primitives';
import styles from './plugins.module.css';

const settings = defineSettings({
  maxLength: {
    type: 'number',
    label: 'Badge length',
    description: 'Longer first lines are cut off; hover to read the whole note.',
    default: 20,
    min: 6,
    max: 40,
    step: 1,
  },
  style: {
    type: 'select',
    label: 'Style',
    default: 'pill',
    options: [
      { value: 'pill', label: 'Outlined pill' },
      { value: 'text', label: 'Plain italic text' },
    ],
  },
  showOwn: {
    type: 'boolean',
    label: 'Show on my own messages',
    default: false,
  },
});

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** First non-empty line of a note, trimmed to `max` characters (grapheme clusters). */
export function noteBadgeText(note: string, max: number): string {
  const line =
    note
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const chars = Array.from(graphemes.segment(line), (s) => s.segment);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line;
}

function makeBadge(ctx: PluginContext<typeof settings>) {
  const subLocal = (fn: () => void) => ctx.stores.local.subscribe(fn);
  const subSettings = (fn: () => void) => ctx.stores.settings.subscribe(fn);
  return function NoteBadge({ message }: { message: Message }) {
    const note = useSyncExternalStore(
      subLocal,
      () => ctx.stores.local.getState().contactNotes[message.authorId] ?? '',
    );
    // Re-render when this plugin's settings change.
    useSyncExternalStore(subSettings, () => ctx.stores.settings.getState().plugins[ctx.pluginId]);
    const self = ctx.stores.session.getState().self?.id;
    if (!note.trim() || (message.authorId === self && !ctx.settings.get('showOwn'))) return null;
    const text = noteBadgeText(note, ctx.settings.get('maxLength'));
    return (
      <Tooltip label={<span className={styles.noteFull}>{note.trim()}</span>}>
        <span
          className={styles.note}
          data-style={ctx.settings.get('style')}
          data-snowdrop="note-badge"
          tabIndex={0}
          aria-label={`Your note: ${note.trim()}`}
        >
          <span>{text}</span>
        </span>
      </Tooltip>
    );
  };
}

export const contactNotesBadgePlugin = definePlugin({
  id: 'note-badge',
  name: 'Pronoun & Notes Badge',
  description:
    'Shows the first line of your private note about someone (pronouns, a nickname, how you know them) next to their name.',
  authors: ['snowdrop'],
  tags: ['appearance', 'messages'],
  settings,
  start(ctx) {
    ctx.messages.addDecoration('note-badge', makeBadge(ctx));
  },
});
