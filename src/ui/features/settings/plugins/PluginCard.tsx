import { LoaderCircle, Lock, RotateCw, Settings2, TriangleAlert } from 'lucide-react';
import { useId, useRef } from 'react';
import type { PluginInfo } from '@/core/plugins';
import { useShrike } from '@/ui/hooks';
import { Button, IconButton, Switch, Tooltip } from '@/ui/primitives';
import { errorMessage } from './usePlugins';
import styles from './plugins.module.css';

export interface PluginCardProps {
  info: PluginInfo;
  onOpenSettings: () => void;
  onTag: (tag: string) => void;
  activeTag: string | null;
}

export function PluginCard({ info, onOpenSettings, onTag, activeTag }: PluginCardProps) {
  const { plugins } = useShrike();
  const { definition: d, enabled, status } = info;
  const titleId = useId();
  const switchRef = useRef<HTMLDivElement>(null);
  const descId = useId();
  const hasSettings = Object.values(d.settings ?? {}).some((def) => !def.hidden);
  const failed = status === 'failed';
  // A running plugin's latest failure (a hover action, command, transform…); Retry restarts it.
  const runtimeError = status === 'running' ? info.runtimeError : undefined;
  return (
    <article
      className={styles.card}
      data-enabled={enabled ? '' : undefined}
      data-status={status}
      aria-labelledby={titleId}
      data-shrike="plugin-card"
    >
      <header className={styles.cardHeader}>
        <h3 id={titleId} className={styles.cardTitle}>
          {d.name}
        </h3>
        {d.required && (
          <Tooltip label="Part of Shrike’s core; can’t be turned off.">
            <span className={styles.required} tabIndex={0}>
              <Lock size={11} aria-hidden />
              Required
            </span>
          </Tooltip>
        )}
        <span className={styles.cardControls}>
          {hasSettings && (
            <IconButton
              size="sm"
              label={`${d.name} settings`}
              icon={<Settings2 />}
              onClick={onOpenSettings}
            />
          )}
          <span ref={switchRef} className={styles.switchWrap}>
            <Switch
              checked={enabled}
              disabled={d.required ?? false}
              ariaLabel={`${enabled ? 'Disable' : 'Enable'} ${d.name}`}
              aria-describedby={descId}
              onCheckedChange={(on) => {
                void plugins.setEnabled(d.id, on);
              }}
            />
          </span>
        </span>
      </header>
      <p id={descId} className={styles.cardDescription}>
        {d.description}
      </p>
      {(failed || runtimeError) && (
        <div className={styles.failure} role="alert">
          <TriangleAlert size={14} aria-hidden />
          <span className={styles.failureText}>
            {runtimeError
              ? `Failed in ${runtimeError.where}: ${errorMessage(runtimeError.error)}`
              : `Failed to start: ${errorMessage(info.error)}`}
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCw size={14} />}
            onClick={() => {
              // The Retry button disappears on success: keep focus on the card.
              switchRef.current?.querySelector<HTMLElement>('[role=switch]')?.focus();
              void plugins.retry(d.id);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <footer className={styles.cardFooter}>
        <span className={styles.authors}>
          {d.authors.length === 1 && d.authors[0] === 'shrike'
            ? 'Built in'
            : `by ${d.authors.join(', ')}`}
        </span>
        {status === 'starting' && (
          <span className={styles.starting}>
            <LoaderCircle size={12} aria-hidden className={styles.spin} /> Starting…
          </span>
        )}
        <span className={styles.tags}>
          {(d.tags ?? []).map((tag) => (
            <button
              key={tag}
              type="button"
              className={styles.tag}
              aria-pressed={activeTag === tag}
              onClick={() => {
                onTag(tag);
              }}
            >
              {tag}
            </button>
          ))}
        </span>
      </footer>
    </article>
  );
}
