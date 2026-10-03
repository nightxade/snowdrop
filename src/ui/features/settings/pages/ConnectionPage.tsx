import { CircleCheck, CircleX, LoaderCircle, PlugZap, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { BackendKind } from '@/core/backend';
import type { DesktopConnection } from '@/core/stores';
import { validateDaemonUrl } from '@/ui/features/onboarding';
import { useSnowdrop, type DaemonProbe } from '@/ui/hooks';
import { Button, Modal, Segmented, Switch, TextInput } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';
import { DesktopConnectionRows } from './DesktopConnectionRows';
import styles from './pages.module.css';

const STATUS_TEXT = {
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline',
  error: 'Can’t connect',
} as const;

/** Explains a failed probe in terms of what to do next. */
function probeAdvice(result: Extract<DaemonProbe, { ok: false }>): string {
  switch (result.kind) {
    case 'unreachable':
      return 'Nothing answered at that address. Is the daemon running (signal-cli daemon --http 127.0.0.1:8080), and is the dev proxy pointing at it?';
    case 'timeout':
      return 'The daemon didn’t answer within 5 seconds.';
    case 'http':
      return `The daemon refused the request: ${result.message}. A 421 means the Host header was rejected; use the /signal-cli proxy path.`;
    case 'invalid-response':
      return 'Something answered, but it isn’t signal-cli’s HTTP API.';
    default:
      return result.message;
  }
}

export function ConnectionPage() {
  const app = useSnowdrop();
  const [saved, set] = useSettingsSection('connection');
  const status = useStore(app.stores.session, (s) => s.status);
  const running = app.backend.kind;
  // Every registered transport (app/backends.ts), in registration order.
  const options = app.backends.options();
  const runningLabel = options.find((o) => o.kind === running)?.label ?? running;
  const [backend, setBackend] = useState<BackendKind>(saved.backend ?? running);
  const [url, setUrl] = useState(saved.daemonUrl);
  const [account, setAccount] = useState(saved.account ?? '');
  const [probe, setProbe] = useState<DaemonProbe | 'testing' | null>(null);
  const [confirm, setConfirm] = useState(false);
  // The desktop app runs signal-cli itself: no daemon URL, its own settings.
  const desktopAdmin = app.desktop;
  const [desktop, setDesktop] = useState<DesktopConnection>(saved.desktop);

  const urlError = backend === 'signal-cli' && !desktopAdmin ? validateDaemonUrl(url) : null;
  const desktopChanged = (Object.keys(desktop) as (keyof DesktopConnection)[]).some(
    (key) => desktop[key] !== saved.desktop[key],
  );
  const changed =
    backend !== running ||
    (backend === 'signal-cli' &&
      (desktopAdmin
        ? desktopChanged
        : url.trim() !== saved.daemonUrl || (account.trim() || null) !== saved.account));

  const apply = () => {
    set({
      backend,
      ...(backend === 'signal-cli'
        ? desktopAdmin
          ? { desktop }
          : { daemonUrl: url.trim(), account: account.trim() || null }
        : {}),
    });
    app.admin.flush();
    window.location.reload();
  };

  return (
    <>
      <SettingsSection>
        <SettingRow
          id="connection.backend"
          label="Source"
          description={
            <>
              Now using{' '}
              <strong className={styles.strong}>
                {running === 'mock' ? 'the demo' : runningLabel}
              </strong>
              :{' '}
              <span data-status={status} className={styles.status}>
                {STATUS_TEXT[status]}
              </span>
            </>
          }
          control={(ids) => (
            <Segmented
              labelledBy={ids.labelId}
              label="Source"
              value={backend}
              options={options.map((o) => ({ value: o.kind, label: o.label }))}
              onValueChange={(v) => {
                setBackend(v);
                setProbe(null);
              }}
            />
          )}
        />
        {backend === 'signal-cli' && desktopAdmin && (
          <DesktopConnectionRows admin={desktopAdmin} value={desktop} onChange={setDesktop} />
        )}
        {backend === 'signal-cli' && !desktopAdmin && (
          <>
            <SettingRow
              id="connection.url"
              label="Daemon address"
              description="The same-origin proxy path (/signal-cli) unless you’ve set up your own. The daemon has no CORS support."
              stacked
              control={(ids) => (
                <TextInput
                  id={ids.id}
                  className={styles.wide}
                  value={url}
                  spellCheck={false}
                  autoComplete="off"
                  error={urlError ?? undefined}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setProbe(null);
                  }}
                />
              )}
            />
            <SettingRow
              id="connection.account"
              label="Account"
              description="Phone number (+44…) or ACI. Leave empty to use the daemon’s first account; required for a daemon started with -a."
              stacked
              control={(ids) => (
                <TextInput
                  id={ids.id}
                  className={styles.wide}
                  value={account}
                  placeholder="Automatic"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    setAccount(e.target.value);
                  }}
                />
              )}
            />
            <SettingRow
              id="connection.test"
              label="Test connection"
              description="Checks the daemon answers and has an account. Nothing is sent."
              control={
                <Button
                  icon={
                    probe === 'testing' ? (
                      <LoaderCircle size={16} className={styles.spin} />
                    ) : (
                      <PlugZap size={16} />
                    )
                  }
                  disabled={probe === 'testing' || urlError !== null}
                  onClick={() => {
                    setProbe('testing');
                    void app.admin.probeDaemon(url.trim()).then(setProbe);
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
                  probe.ok ? (
                    <>
                      <CircleCheck size={14} aria-hidden />
                      {probe.accounts === null
                        ? 'The daemon is running (single-account mode: enter the account above).'
                        : probe.accounts === 0
                          ? 'The daemon is running but has no account yet. After switching, Snowdrop will help you link this device.'
                          : `The daemon is running with ${probe.accounts} account${probe.accounts === 1 ? '' : 's'}.`}
                    </>
                  ) : (
                    <>
                      <CircleX size={14} aria-hidden />
                      {probeAdvice(probe)}
                    </>
                  )
                ) : undefined
              }
            />
          </>
        )}
        {running === 'mock' && backend === 'mock' && (
          <SettingRow
            id="connection.liveliness"
            label="Simulated activity"
            description="People in the demo keep chatting, typing and reacting."
            control={(ids) => (
              <Switch
                id={ids.id}
                aria-describedby={ids.descriptionId}
                checked={saved.mockLiveliness}
                onCheckedChange={(mockLiveliness) => {
                  set({ mockLiveliness });
                }}
              />
            )}
          />
        )}
      </SettingsSection>
      {changed && (
        <div className={styles.applyBar} role="region" aria-label="Unapplied connection changes">
          <p>Connection changes take effect after Snowdrop reloads.</p>
          <Button
            variant="primary"
            icon={<RefreshCw size={16} />}
            disabled={urlError !== null}
            onClick={() => {
              setConfirm(true);
            }}
          >
            Apply and reload
          </Button>
        </div>
      )}
      {confirm && (
        <Modal
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open) setConfirm(false);
          }}
          title="Reload Snowdrop?"
          description={
            backend === 'mock'
              ? `Snowdrop will reload into the demo. Your signal-cli history stays stored ${desktopAdmin ? 'on this computer' : 'in this browser'}.`
              : 'Snowdrop will reload and connect to signal-cli. Unsent drafts are kept.'
          }
          footer={
            <>
              <Button
                variant="ghost"
                data-autofocus
                onClick={() => {
                  setConfirm(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={apply}>
                Reload now
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
