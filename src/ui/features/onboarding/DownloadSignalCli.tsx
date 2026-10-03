import { CloudDownload, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DesktopAdmin, InstallProgress, PinnedRelease } from '@/core/backend';
import { Button } from '@/ui/primitives';
import styles from './Setup.module.css';

type Phase =
  | { step: 'idle' }
  | { step: 'downloading'; received: number; total: number | null }
  | { step: 'error'; message: string };

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** A human explanation for each way the download can fail (PLAN: clear errors). */
function errorMessage(kind: string, message: string): string {
  switch (kind) {
    case 'unreachable':
    case 'timeout':
      return "Couldn't reach github.com. Check your connection and try again.";
    case 'config':
      return message.toLowerCase().includes('checksum')
        ? "The download didn't match what Snowdrop expected (a checksum mismatch). Try again — if it keeps happening, your network may be altering the download."
        : message;
    case 'cancelled':
      return 'Download cancelled.';
    case 'internal':
      return `Couldn't save signal-cli (${message.toLowerCase().includes('no space') ? 'the disk may be full' : 'a disk problem'}). ${message}`;
    default:
      return message;
  }
}

/**
 * Desktop app, first run: no signal-cli configured and none found anywhere.
 * Snowdrop downloads the pinned signal-cli release itself, so there's
 * nothing for the person to go install by hand (PLAN: download by default).
 */
export function DownloadSignalCli({
  admin,
  onInstalled,
}: {
  admin: DesktopAdmin;
  onInstalled: () => void;
}) {
  const [release, setRelease] = useState<PinnedRelease | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });

  useEffect(() => {
    let live = true;
    void admin.pinnedRelease().then((r) => {
      if (live) setRelease(r);
    });
    return () => {
      live = false;
    };
  }, [admin]);

  const start = () => {
    setPhase({ step: 'downloading', received: 0, total: null });
    const onProgress = (p: InstallProgress) => {
      setPhase((prev) => (prev.step === 'downloading' ? { ...prev, received: p.received, total: p.total } : prev));
    };
    void admin.install(onProgress).then((result) => {
      if (result.ok) {
        onInstalled();
      } else {
        setPhase({ step: 'error', message: errorMessage(result.kind, result.message) });
      }
    });
  };

  const cancel = () => {
    void admin.cancelInstall();
  };

  const repoName = release ? release.repo.replace(/^https?:\/\//u, '') : 'github.com/AsamK/signal-cli';
  const size = release?.downloadSizeBytes != null ? megabytes(release.downloadSizeBytes) : '~114 MB';

  return (
    <section className={styles.card} aria-labelledby="download-title">
      <h2 id="download-title" className={styles.title}>
        Get signal-cli
      </h2>
      {phase.step !== 'downloading' && (
        <p className={styles.lede}>
          Snowdrop talks to Signal through <code>signal-cli</code>, an independent, open-source
          program. It isn’t included in Snowdrop itself — the app stays small, and signal-cli
          always comes straight from its own authors — so the first time, Snowdrop downloads{' '}
          {release ? `signal-cli ${release.version}` : 'it'} from {repoName} (about {size}). It
          only runs on this computer, as a separate program Snowdrop starts and stops for you.
        </p>
      )}
      {phase.step === 'idle' && (
        <div className={styles.actions}>
          <Button type="button" variant="primary" icon={<CloudDownload size={16} />} onClick={start}>
            Download and continue
          </Button>
        </div>
      )}
      {phase.step === 'downloading' && (
        <div className={styles.waiting} aria-live="polite">
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label={`Downloading signal-cli${release ? ` ${release.version}` : ''}`}
            aria-valuemin={0}
            {...(phase.total !== null
              ? { 'aria-valuenow': phase.received, 'aria-valuemax': phase.total }
              : { 'aria-valuetext': 'Downloading…' })}
          >
            <div
              className={styles.progressFill}
              data-indeterminate={phase.total === null ? '' : undefined}
              style={phase.total !== null ? { width: `${Math.min(100, (phase.received / phase.total) * 100)}%` } : undefined}
            />
          </div>
          <p className={styles.progressMeta}>
            <span>
              {megabytes(phase.received)}
              {phase.total !== null ? ` of ${megabytes(phase.total)}` : ''}
            </span>
          </p>
          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {phase.step === 'error' && (
        <>
          <p className={styles.error} role="alert">
            <TriangleAlert size={14} aria-hidden /> {phase.message}
          </p>
          <div className={styles.actions}>
            <Button type="button" variant="primary" icon={<RotateCw size={16} />} onClick={start}>
              Try again
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
