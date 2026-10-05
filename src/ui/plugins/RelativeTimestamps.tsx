import { useSyncExternalStore } from 'react';
import { formatFullTimestamp, formatRelative, type Message } from '@/core/domain';
import { defineExtension, defineSettings, type PluginContext } from '@/core/plugins';
import { useNow } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import styles from './plugins.module.css';

const settings = defineSettings({
  mode: {
    type: 'select',
    label: 'Display',
    description: 'Relative only replaces the clock time next to names; both keeps it.',
    default: 'relative',
    options: [
      { value: 'relative', label: 'Relative only' },
      { value: 'both', label: 'Relative and absolute' },
    ],
  },
});

/** Hides the core header time (stable hook: <time data-variant="header"> in a message). */
const HIDE_ABSOLUTE = `[data-snowdrop='message'] time[data-variant='header'] { display: none; }`;

function makeDecoration(ctx: PluginContext<typeof settings>) {
  const subscribe = (fn: () => void) => ctx.stores.settings.subscribe(fn);
  return function RelativeTime({ message }: { message: Message }) {
    // The shared one-minute ticker: one timer for every visible row.
    const now = useNow(60_000);
    const clock24h = useSyncExternalStore(
      subscribe,
      () => ctx.stores.settings.getState().appearance.clock24h,
    );
    return (
      <Tooltip label={formatFullTimestamp(message.sentAt, { clock24h })} delayMs={300}>
        <time className={styles.relative} dateTime={new Date(message.sentAt).toISOString()}>
          {formatRelative(message.sentAt, now)}
        </time>
      </Tooltip>
    );
  };
}

export const relativeTimestampsPlugin = defineExtension({
  id: 'relative-timestamps',
  name: 'Relative Timestamps',
  description: 'Shows “3m ago” next to names, with the exact time on hover. Updates every minute.',
  authors: ['snowdrop'],
  tags: ['appearance', 'messages'],
  settings,
  start(ctx) {
    ctx.messages.addDecoration('relative-time', makeDecoration(ctx));
    let hide: (() => void) | null = null;
    const sync = (mode: string) => {
      if (mode === 'relative' && !hide) hide = ctx.styles.inject(HIDE_ABSOLUTE, 'hide-absolute');
      if (mode !== 'relative' && hide) {
        hide();
        hide = null;
      }
    };
    sync(ctx.settings.get('mode'));
    ctx.settings.subscribe((values) => {
      sync(values.mode);
    });
  },
});
