import { Sparkles } from 'lucide-react';
import { useSnowdrop } from '@/ui/hooks';
import { Button } from '@/ui/primitives';
import styles from './DemoBanner.module.css';

/**
 * Persistent reminder that the running backend is the demo (PLAN §4.10): a
 * slim, non-dismissible strip above the shell with a one-click way out. The
 * button's intent is explicit, so it leaves straight away — no confirm
 * dialog, unlike the Settings → "Sign out…" entry point for the same flow.
 *
 * `leaveDemo` is loaded on demand (not a top-level import) so this
 * always-mounted banner doesn't pull Settings into the main chunk.
 */
export function DemoBanner() {
  const app = useSnowdrop();
  if (app.backend.kind !== 'mock') return null;

  return (
    <div className={styles.banner} role="status" data-snowdrop="demo-banner">
      <Sparkles size={16} aria-hidden />
      <span className={styles.text}>You're exploring the demo — nothing here is real.</span>
      <Button
        size="sm"
        variant="secondary"
        className={styles.action}
        onClick={() => {
          void import('@/ui/features/settings').then(({ leaveDemo }) => leaveDemo(app));
        }}
      >
        Use your Signal account
      </Button>
    </div>
  );
}
