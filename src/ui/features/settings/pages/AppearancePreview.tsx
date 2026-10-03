import { formatClock } from '@/core/domain';
import { useNow } from '@/ui/hooks';
import { Avatar } from '@/ui/primitives';
import { useSettingsSection } from '../useSettingsSection';
import styles from './pages.module.css';

const SAMPLE = [
  {
    name: 'Mira Okafor',
    hue: 7,
    text: 'Rope’s in the car. Leaving at 6 if anyone wants a lift.',
    ago: 9,
  },
  { name: 'Theo Lind', hue: 1, text: 'Count me in, I’ll bring the chalk.', ago: 3 },
];

/** Two sample messages rendered with the current density, clock and avatar settings. */
export function AppearancePreview() {
  const [a] = useSettingsSection('appearance');
  const now = useNow();
  const compact = a.density === 'compact';
  return (
    <div className={styles.preview} data-density={a.density} aria-label="Preview" role="img">
      {SAMPLE.map((m) => (
        <div key={m.name} className={styles.previewMsg}>
          {compact ? (
            <>
              <span className={styles.previewTime}>
                {formatClock(now - m.ago * 60_000, { clock24h: a.clock24h })}
              </span>
              {a.showAvatarsInCompact && (
                <Avatar size={16} fallback="" color={`var(--snowdrop-avatar-${m.hue})`} />
              )}
              <span className={styles.previewName}>{m.name}</span>
              <span className={styles.previewText}>{m.text}</span>
            </>
          ) : (
            <>
              <Avatar
                size={40}
                fallback={m.name.slice(0, 1)}
                color={`var(--snowdrop-avatar-${m.hue})`}
              />
              <span className={styles.previewBody}>
                <span>
                  <span className={styles.previewName}>{m.name}</span>{' '}
                  <span className={styles.previewTime}>
                    Today at {formatClock(now - m.ago * 60_000, { clock24h: a.clock24h })}
                  </span>
                </span>
                <span className={styles.previewText}>{m.text}</span>
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
