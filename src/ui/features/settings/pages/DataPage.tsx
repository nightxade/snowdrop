import {
  Copy,
  Download,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { recentLogLines } from '@/core/lib';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal, Switch } from '@/ui/primitives';
import { downloadText } from '../download';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';
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

/**
 * Settings → Data & storage → Diagnostics: a verbose-logging switch and
 * ways to get at the log itself. Desktop has an actual on-disk log
 * (`app.logs`); the browser build falls back to the in-memory ring buffer
 * (`recentLogLines`, `src/core/lib/log.ts`) and has no folder to open.
 */
function DiagnosticsSection() {
  const app = useSnowdrop();
  const [b, set] = useSettingsSection('behaviour');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copyRecentLog = async () => {
    setCopied(false);
    setCopyError(null);
    try {
      const text = app.logs
        ? await app.logs.recent(65536)
        : recentLogLines().join('\n') || 'No log lines yet.';
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopyError('Could not copy the log.');
    }
  };

  return (
    <SettingsSection
      id="diagnostics"
      title="Diagnostics"
      rowIds={['data.diagnosticsVerbose', 'data.diagnosticsCopyLog', 'data.diagnosticsOpenFolder']}
    >
      <SettingRow
        id="data.diagnosticsVerbose"
        label="Verbose logging"
        description="Keeps a more detailed log for a while, to help track down a problem. Turn it off again once you're done — it uses a little more disk and battery."
        control={(ids) => (
          <Switch
            id={ids.id}
            aria-describedby={ids.descriptionId}
            checked={b.verboseLogging}
            onCheckedChange={(v) => {
              set({ verboseLogging: v });
            }}
          />
        )}
      />
      <SettingRow
        id="data.diagnosticsCopyLog"
        label="Copy recent log"
        description="Copies the last part of the log to your clipboard — handy when reporting a problem."
        noteTone={copyError ? 'danger' : 'success'}
        note={copyError ?? (copied ? 'Copied.' : undefined)}
        control={
          <Button
            icon={<Copy size={16} />}
            onClick={() => {
              void copyRecentLog();
            }}
          >
            Copy
          </Button>
        }
      />
      {app.logs && (
        <SettingRow
          id="data.diagnosticsOpenFolder"
          label="Open log folder"
          description="Opens the folder holding snowdrop.log in your file manager."
          control={
            <Button
              icon={<FolderOpen size={16} />}
              onClick={() => {
                app.logs?.openFolder();
              }}
            >
              Open
            </Button>
          }
        />
      )}
      <p className={styles.muted}>
        Logs stay on this computer, never contain message text, phone numbers or account IDs, and
        are deleted by Settings → Privacy &amp; security → Erase all local data.
      </p>
    </SettingsSection>
  );
}

type Danger = 'clear' | 'reset' | null;

/**
 * Settings → Data & storage: status of `HistoryImportService`'s one-time
 * archive import. Hidden while there's nothing to report (the demo, upstream
 * signal-cli, or before the first sync has even checked) — see
 * `HistoryImportService`'s capability check.
 */
function HistoryImportRow() {
  const app = useSnowdrop();
  const historyImport = useStore(app.stores.session, sessionSelectors.historyImport);
  const [retrying, setRetrying] = useState(false);
  if (historyImport.status === 'idle') return null;

  const description =
    historyImport.status === 'importing'
      ? `Importing your phone's message history into search — ${historyImport.percent}% so far.`
      : historyImport.status === 'done'
        ? `Finished importing your phone's message history (${historyImport.imported.toLocaleString()} messages).`
        : (historyImport.error ?? "Importing your phone's message history failed.");

  return (
    <SettingRow
      id="data.historyImport"
      label="Message history import"
      description={description}
      stacked={historyImport.status === 'importing'}
      control={
        historyImport.status === 'failed' ? (
          <Button
            icon={<RefreshCw size={16} className={retrying ? styles.spin : undefined} />}
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void app.historyImport.retry().finally(() => {
                setRetrying(false);
              });
            }}
          >
            Retry
          </Button>
        ) : undefined
      }
    >
      {historyImport.status === 'importing' && (
        <div
          className={styles.meter}
          role="progressbar"
          aria-label="Importing message history"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={historyImport.percent}
        >
          <span style={{ width: `${Math.max(1, historyImport.percent)}%` }} />
        </div>
      )}
    </SettingRow>
  );
}

export function DataPage() {
  const app = useSnowdrop();
  // The desktop app keeps history in its encrypted store on disk, not a browser.
  const here = app.storageAdmin ? 'on this computer' : 'in this browser';
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
      downloadText(`snowdrop-history-${date}.json`, JSON.stringify(data, null, 2));
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
    await app.admin.reload();
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
                ? 'Storage use isn’t available here.'
                : `${formatBytes(estimate.usage)} of about ${formatBytes(estimate.quota)} available to Snowdrop ${here}.`
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
              ? 'Downloads the demo’s messages as JSON (the demo regenerates its history each launch). Disappearing messages and attachment files are left out.'
              : `Downloads the messages stored ${here} as a JSON file; signal-cli keeps no history, so this is your backup. Disappearing messages are left out, and attachments are listed by name and type only.`)
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
        <HistoryImportRow />
      </SettingsSection>
      <DiagnosticsSection />
      <SettingsSection title="Danger zone" rowIds={['data.clear', 'data.reset']}>
        <SettingRow
          id="data.clear"
          label="Clear history"
          description={`Deletes every message stored ${here}. Your phone and other devices keep theirs; spaces, notes and settings stay.`}
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
          description="Theme, keybinds, plugins and Custom CSS go back to their defaults. Messages, spaces and the connection are kept."
          control={
            <Button
              variant="danger"
              icon={<RotateCcw size={16} />}
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
              ? `Messages stored ${here} are deleted for good, unless you exported them. Snowdrop reloads afterwards.`
              : 'Your theme, keybinds, plugin choices and Custom CSS are reset. Snowdrop reloads afterwards.'
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
