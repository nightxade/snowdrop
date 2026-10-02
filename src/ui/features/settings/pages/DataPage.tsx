import { Download, LoaderCircle, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShrike } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { downloadText } from '../download';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import styles from './pages.module.css';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'TB'}`;
}

function storageManager(): StorageManager | undefined {
  // Missing on insecure origins and old browsers, whatever the DOM types say.
  const nav: { storage?: StorageManager } | undefined =
    typeof navigator === 'undefined' ? undefined : navigator;
  return nav?.storage;
}

function useStorageEstimate(): { usage: number; quota: number } | 'unavailable' | null {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | 'unavailable' | null>(
    () => (storageManager()?.estimate ? null : 'unavailable'),
  );
  useEffect(() => {
    let live = true;
    const storage = storageManager();
    if (!storage?.estimate) return;
    storage.estimate().then(
      (e) => {
        if (live) setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
      },
      () => {
        if (live) setEstimate('unavailable');
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return estimate;
}

type Danger = 'clear' | 'reset' | null;

export function DataPage() {
  const app = useShrike();
  const estimate = useStorageEstimate();
  const [exporting, setExporting] = useState<string | null>(null);
  const [danger, setDanger] = useState<Danger>(null);
  const [busy, setBusy] = useState(false);
  const demo = app.backend.kind === 'mock';

  const runExport = async () => {
    setExporting('Preparing…');
    try {
      const data = await app.admin.exportHistory((done, total) => {
        setExporting(`Reading ${done} of ${total} conversations…`);
      });
      const count = data.conversations.reduce((n, c) => n + c.messages.length, 0);
      const date = data.exportedAt.slice(0, 10);
      downloadText(`shrike-history-${date}.json`, JSON.stringify(data, null, 2));
      app.stores.ui.getState().pushToast({
        message: `Exported ${count.toLocaleString()} messages`,
        kind: 'success',
        source: 'core',
      });
    } catch (error) {
      app.stores.ui.getState().pushToast({
        message: `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        kind: 'error',
        source: 'core',
      });
    } finally {
      setExporting(null);
    }
  };

  const confirmDanger = async () => {
    setBusy(true);
    if (danger === 'clear') await app.admin.clearHistory();
    if (danger === 'reset') {
      // Keep the connection so a reset doesn't drop you back on the welcome screen.
      const connection = app.stores.settings.getState().connection;
      app.stores.settings.getState().reset();
      app.stores.settings.getState().update('connection', connection);
    }
    app.admin.flush();
    window.location.reload();
  };

  const fraction =
    estimate && estimate !== 'unavailable' && estimate.quota > 0
      ? estimate.usage / estimate.quota
      : 0;

  return (
    <>
      <SettingsSection>
        <SettingRow
          id="data.usage"
          label="Storage used"
          description={
            estimate === null
              ? 'Measuring…'
              : estimate === 'unavailable'
                ? 'This browser doesn’t report storage use.'
                : `${formatBytes(estimate.usage)} of about ${formatBytes(estimate.quota)} available to Shrike in this browser.`
          }
          stacked
        >
          {estimate && estimate !== 'unavailable' && (
            <div
              className={styles.meter}
              role="meter"
              aria-label="Storage used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
            >
              <span style={{ width: `${Math.max(1, Math.min(100, fraction * 100))}%` }} />
            </div>
          )}
        </SettingRow>
        <SettingRow
          id="data.export"
          label="Export history"
          description={
            exporting ??
            (demo
              ? 'Downloads the demo’s messages as JSON (the demo regenerates its history each launch).'
              : 'Downloads every message stored in this browser as a JSON file. signal-cli keeps no history, so this is your backup.')
          }
          control={
            <Button
              icon={
                exporting ? (
                  <LoaderCircle size={16} className={styles.spin} />
                ) : (
                  <Download size={16} />
                )
              }
              disabled={exporting !== null}
              onClick={() => {
                void runExport();
              }}
            >
              Export
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection title="Danger zone">
        <SettingRow
          id="data.clear"
          label="Clear history"
          description="Deletes every stored message from this browser. Your phone and other devices keep theirs; spaces, notes and settings stay."
          control={
            <Button
              variant="danger"
              icon={<Trash2 size={16} />}
              onClick={() => {
                setDanger('clear');
              }}
            >
              Clear…
            </Button>
          }
        />
        <SettingRow
          id="data.reset"
          label="Reset all settings"
          description="Theme, keybinds, plugins and QuickCSS go back to their defaults. Messages, spaces and the connection are kept."
          control={
            <Button
              variant="danger"
              onClick={() => {
                setDanger('reset');
              }}
            >
              Reset…
            </Button>
          }
        />
      </SettingsSection>
      {danger && (
        <Modal
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open && !busy) setDanger(null);
          }}
          title={danger === 'clear' ? 'Clear all message history?' : 'Reset all settings?'}
          description={
            danger === 'clear'
              ? 'Messages stored in this browser are deleted for good, unless you exported them. Shrike reloads afterwards.'
              : 'Your theme, keybinds, plugin choices and QuickCSS are reset. Shrike reloads afterwards.'
          }
          footer={
            <>
              <Button
                variant="ghost"
                data-autofocus
                disabled={busy}
                onClick={() => {
                  setDanger(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  void confirmDanger();
                }}
              >
                {danger === 'clear' ? 'Clear history' : 'Reset settings'}
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
