import { CircleCheck, CircleX, LoaderCircle, PlugZap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DesktopAdmin, DesktopProbeResult, LocateResult } from '@/core/backend';
import type { DesktopConnection } from '@/core/stores';
import { Button, Segmented, Switch, TextInput } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import styles from './pages.module.css';

const SOURCE_TEXT = {
  bundled: 'the copy bundled with Snowdrop',
  configured: 'the path below',
  path: 'the one on your PATH',
} as const;

function probeNote(result: DesktopProbeResult): string {
  if (!result.ok) return result.message;
  const program = result.program ? ` (${SOURCE_TEXT[result.program.source]})` : '';
  const version = result.version
    ? `signal-cli ${result.version}${program} works`
    : 'The daemon is running';
  if (result.accounts === null) return `${version}.`;
  if (result.accounts === 0)
    return `${version}, with no account yet: Snowdrop will help you link this computer.`;
  return `${version}, with ${result.accounts} account${result.accounts === 1 ? '' : 's'}.`;
}

/**
 * Settings → Connection in the desktop app: Snowdrop runs signal-cli itself
 * (the bundled copy by default, or one you installed), or connects to a
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
  const [bundled, setBundled] = useState<string | null>(null);
  const [located, setLocated] = useState<LocateResult | null>(null);
  const [probe, setProbe] = useState<DesktopProbeResult | 'testing' | null>(null);
  const set = (patch: Partial<DesktopConnection>) => {
    setProbe(null);
    onChange({ ...value, ...patch });
  };

  useEffect(() => {
    let live = true;
    void admin.info().then((info) => {
      if (live) setBundled(info.bundledSignalCli);
    });
    return () => {
      live = false;
    };
  }, [admin]);

  const { useBundled, binaryPath } = value;
  useEffect(() => {
    let live = true;
    // Debounced: typing a path shouldn't hit the disk per keystroke.
    const timer = setTimeout(() => {
      void admin.locate({ useBundled, binaryPath }).then((result) => {
        if (live) setLocated(result);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [admin, useBundled, binaryPath]);

  const usingBundled = value.useBundled && bundled !== null;
  const programNote = located
    ? located.ok
      ? `Snowdrop will run ${located.source === 'bundled' ? `the bundled signal-cli ${bundled ?? ''}`.trim() : located.path}.`
      : located.message
    : undefined;

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
            id="connection.program"
            label="signal-cli program"
            description={
              bundled
                ? 'This build comes with signal-cli. Turn this off to use one you installed.'
                : 'This build has no bundled signal-cli: give the path of yours, or leave it empty to find it on your PATH.'
            }
            stacked={!usingBundled}
            noteTone={located && !located.ok ? 'warning' : 'info'}
            note={programNote}
            control={(ids) =>
              usingBundled ? (
                <Switch
                  id={ids.id}
                  aria-describedby={ids.descriptionId}
                  checked
                  onCheckedChange={(on) => {
                    set({ useBundled: on });
                  }}
                />
              ) : (
                <div className={styles.stack}>
                  {bundled && (
                    <Switch
                      checked={false}
                      label={`Use the bundled signal-cli ${bundled}`}
                      onCheckedChange={(on) => {
                        set({ useBundled: on });
                      }}
                    />
                  )}
                  <TextInput
                    id={ids.id}
                    className={styles.wide}
                    value={value.binaryPath}
                    placeholder="Find signal-cli on PATH"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="signal-cli path"
                    onChange={(e) => {
                      set({ binaryPath: e.target.value });
                    }}
                  />
                </div>
              )
            }
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
              void admin.probe(value).then(setProbe);
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
