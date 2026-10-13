import { CircleCheck, CircleX, DownloadCloud, LoaderCircle, PlugZap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  DesktopAdmin,
  DesktopProbeResult,
  InstallStatus,
  LocateResult,
  ResolvedProgram,
} from '@/core/backend';
import { createLogger } from '@/core/lib';
import type { DesktopConnection } from '@/core/stores';
import { friendlyErrorMessage } from '@/ui/lib/connectionErrors';
import { Button, Segmented, TextInput } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import styles from './pages.module.css';

const log = createLogger('signal-cli');

/** `satisfies` keeps this exhaustive against `ResolvedProgram['source']` at the type level. */
const SOURCE_TEXT = {
  patched: 'the history-enabled build (patched) installed for Snowdrop',
  downloaded: 'the signal-cli Snowdrop downloaded',
  bundled: 'the copy bundled with Snowdrop',
  configured: 'the path below',
  path: 'the one on your PATH',
} satisfies Record<ResolvedProgram['source'], string>;

/**
 * Looks up `SOURCE_TEXT`, falling back at runtime for a `source` that isn't
 * one of the known values — e.g. a desktop build newer than this UI, or a
 * value that reached here without going through the IPC boundary's own
 * validation. Never renders "undefined".
 */
function sourceText(source: ResolvedProgram['source']): string {
  return (
    (SOURCE_TEXT as Record<string, string | undefined>)[source] ??
    "Snowdrop couldn't determine which signal-cli it will use."
  );
}

function probeNote(result: DesktopProbeResult): string {
  if (!result.ok) return friendlyErrorMessage(result.kind, result.message);
  const program = result.program ? ` (${sourceText(result.program.source)})` : '';
  const version = result.version
    ? `signal-cli ${result.version}${program} works`
    : 'The daemon is running';
  if (result.accounts === null) return `${version}.`;
  if (result.accounts === 0)
    return `${version}, with no account yet: Snowdrop will help you link this computer.`;
  return `${version}, with ${result.accounts} account${result.accounts === 1 ? '' : 's'}.`;
}

type DownloadState =
  | 'idle'
  | 'downloading'
  | { ok: true; status: InstallStatus }
  | { ok: false; kind: string; message: string };

/**
 * Settings → Connection in the desktop app: Snowdrop runs signal-cli itself
 * (downloaded on first launch, or one you installed), or connects to a
 * daemon you run (advanced). Edits a draft; the page applies it on reload.
 */
export function DesktopConnectionRows({
  admin,
  value,
  onChange,
}: {
  admin: DesktopAdmin;
  value: DesktopConnection;
  onChange: (next: DesktopConnection) => void;
}) {
  const [installed, setInstalled] = useState<InstallStatus | null>(null);
  const [download, setDownload] = useState<DownloadState>('idle');
  const [located, setLocated] = useState<LocateResult | null>(null);
  const [probe, setProbe] = useState<DesktopProbeResult | 'testing' | null>(null);
  const set = (patch: Partial<DesktopConnection>) => {
    setProbe(null);
    onChange({ ...value, ...patch });
  };

  useEffect(() => {
    let live = true;
    void admin.installStatus().then((status) => {
      if (live) setInstalled(status);
    });
    return () => {
      live = false;
    };
  }, [admin]);

  const { binaryPath } = value;
  useEffect(() => {
    let live = true;
    // Debounced: typing a path shouldn't hit the disk per keystroke.
    const timer = setTimeout(() => {
      void admin.locate({ binaryPath }).then((result) => {
        if (!result.ok) log.error('signal-cli locate failed', { kind: result.kind });
        if (live) setLocated(result);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [admin, binaryPath]);

  const programNote = located
    ? located.ok
      ? `Snowdrop will run ${located.source === 'configured' ? located.path : sourceText(located.source)}.`
      : friendlyErrorMessage(located.kind, located.message)
    : undefined;

  const redownload = () => {
    setDownload('downloading');
    void admin
      .install(() => {
        // The settings row only shows a spinner; the full progress bar lives
        // in onboarding's first-run screen (DownloadSignalCli).
      })
      .then((result) => {
        if (!result.ok) log.error('signal-cli install failed', { kind: result.kind });
        setDownload(
          result.ok
            ? { ok: true, status: result.status }
            : { ok: false, kind: result.kind, message: result.message },
        );
        if (result.ok) setInstalled(result.status);
      });
  };

  return (
    <>
      <SettingRow
        id="connection.desktopMode"
        label="Run signal-cli"
        description="Snowdrop starts and stops signal-cli for you. Advanced: connect to a signal-cli daemon you run yourself."
        control={(ids) => (
          <Segmented
            labelledBy={ids.labelId}
            label="Run signal-cli"
            value={value.mode}
            options={[
              { value: 'spawn', label: 'Managed by Snowdrop' },
              { value: 'external', label: 'External daemon' },
            ]}
            onValueChange={(mode) => {
              set({ mode });
            }}
          />
        )}
      />
      {value.mode === 'spawn' ? (
        <>
          <SettingRow
            id="connection.installedSignalCli"
            label="Installed signal-cli"
            description="Downloaded automatically the first time Snowdrop needed it, straight from its own release (github.com/AsamK/signal-cli)."
            stacked
            noteTone={typeof download === 'object' && !download.ok ? 'danger' : 'info'}
            note={
              download === 'downloading' ? (
                <>
                  <LoaderCircle size={14} className={styles.spin} aria-hidden /> Downloading…
                </>
              ) : typeof download === 'object' && !download.ok ? (
                <>
                  <CircleX size={14} aria-hidden />{' '}
                  {friendlyErrorMessage(download.kind, download.message)}
                </>
              ) : installed ? (
                installed.installed ? (
                  <>
                    <CircleCheck size={14} aria-hidden /> signal-cli {installed.version}
                    {installed.path ? ` — ${installed.path}` : ''}
                  </>
                ) : (
                  'Not downloaded yet.'
                )
              ) : undefined
            }
            control={
              <Button
                icon={
                  download === 'downloading' ? (
                    <LoaderCircle size={16} className={styles.spin} />
                  ) : (
                    <DownloadCloud size={16} />
                  )
                }
                disabled={download === 'downloading'}
                onClick={redownload}
              >
                {installed?.installed ? 'Re-download' : 'Download'}
              </Button>
            }
          />
          <SettingRow
            id="connection.program"
            label="Custom signal-cli path"
            description="Leave empty to use the signal-cli Snowdrop downloaded (or one on your PATH). Set this only to run a specific signal-cli yourself."
            stacked
            noteTone={located && !located.ok ? 'warning' : 'info'}
            note={programNote}
            control={(ids) => (
              <TextInput
                id={ids.id}
                className={styles.wide}
                value={value.binaryPath}
                placeholder="Find signal-cli automatically"
                spellCheck={false}
                autoComplete="off"
                aria-label="signal-cli path"
                onChange={(e) => {
                  set({ binaryPath: e.target.value });
                }}
              />
            )}
          />
          <SettingRow
            id="connection.account"
            label="One account only"
            description="Optional. Runs signal-cli for this phone number or ACI alone. Leave empty to link new devices and use any account it has."
            stacked
            control={(ids) => (
              <TextInput
                id={ids.id}
                className={styles.wide}
                value={value.account}
                placeholder="Every account"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  set({ account: e.target.value });
                }}
              />
            )}
          />
        </>
      ) : (
        <SettingRow
          id="connection.url"
          label="Daemon address"
          description="A signal-cli daemon on this computer, started with signal-cli daemon --http 127.0.0.1:8080. Only loopback addresses are allowed: the daemon has no authentication."
          stacked
          control={(ids) => (
            <TextInput
              id={ids.id}
              className={styles.wide}
              value={value.externalUrl}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                set({ externalUrl: e.target.value });
              }}
            />
          )}
        />
      )}
      <SettingRow
        id="connection.test"
        label="Test connection"
        description={
          value.mode === 'spawn'
            ? 'Checks that this signal-cli runs. Nothing is sent.'
            : 'Checks the daemon answers and has an account. Nothing is sent.'
        }
        control={
          <Button
            icon={
              probe === 'testing' ? (
                <LoaderCircle size={16} className={styles.spin} />
              ) : (
                <PlugZap size={16} />
              )
            }
            disabled={probe === 'testing'}
            onClick={() => {
              setProbe('testing');
              void admin.probe(value).then((result) => {
                if (!result.ok) log.error('signal-cli probe failed', { kind: result.kind });
                setProbe(result);
              });
            }}
          >
            {probe === 'testing' ? 'Testing…' : 'Test'}
          </Button>
        }
        noteTone={
          probe && probe !== 'testing'
            ? probe.ok
              ? probe.accounts === 0
                ? 'warning'
                : 'success'
              : 'danger'
            : 'info'
        }
        note={
          probe && probe !== 'testing' ? (
            <>
              {probe.ok ? <CircleCheck size={14} aria-hidden /> : <CircleX size={14} aria-hidden />}
              {probeNote(probe)}
            </>
          ) : undefined
        }
      />
    </>
  );
}
