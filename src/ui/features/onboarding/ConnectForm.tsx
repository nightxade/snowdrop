import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, IconButton, TextInput } from '@/ui/primitives';
import styles from './ConnectForm.module.css';

/** Accepts the same-origin proxy path ("/signal-cli") or an http(s) URL. */
export function validateDaemonUrl(value: string): string | null {
  const url = value.trim();
  if (!url) return 'Enter the address of your signal-cli daemon.';
  if (url.startsWith('/')) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? null
      : 'Use an http:// or https:// address.';
  } catch {
    return 'That doesn’t look like an address. Try /signal-cli or http://127.0.0.1:8080.';
  }
}

const DAEMON_COMMAND = 'signal-cli daemon --http 127.0.0.1:8080';

/** A shell command on one line (scrolls rather than wraps) with a copy button. */
function CommandChip({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={styles.command}>
      <code className={styles.commandText}>{command}</code>
      <IconButton
        size="sm"
        label={copied ? 'Copied' : 'Copy command'}
        icon={copied ? <Check /> : <Copy />}
        onClick={() => {
          void navigator.clipboard.writeText(command).then(
            () => {
              setCopied(true);
            },
            () => undefined,
          );
        }}
      />
    </span>
  );
}

export function ConnectForm({
  defaultUrl,
  onConnect,
}: {
  defaultUrl: string;
  onConnect: (daemonUrl: string) => void;
}) {
  const [url, setUrl] = useState(defaultUrl);
  const [touched, setTouched] = useState(false);
  const error = validateDaemonUrl(url);
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!error) onConnect(url.trim());
      }}
    >
      <h2 className={styles.title}>Connect to signal-cli</h2>
      <ol className={styles.steps}>
        <li>Install signal-cli and register or link your number with it.</li>
        <li>
          Start the daemon:
          <CommandChip command={DAEMON_COMMAND} />
        </li>
        <li>
          Keep the address below unless you changed the dev proxy. The daemon has no CORS support,
          so Shrike reaches it through the same-origin path{' '}
          <code className={styles.code}>/signal-cli</code>.
        </li>
      </ol>
      <TextInput
        label="Daemon address"
        value={url}
        spellCheck={false}
        autoComplete="off"
        autoFocus
        error={touched ? error : undefined}
        hint="A path on this app (the dev proxy) or a full URL to the daemon."
        onChange={(e) => {
          setUrl(e.target.value);
        }}
        onBlur={() => {
          setTouched(true);
        }}
      />
      <Button type="submit" variant="primary" size="lg" fullWidth>
        Connect
      </Button>
    </form>
  );
}
