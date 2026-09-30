# Running Hearth against signal-cli

Hearth talks to the Signal network through [signal-cli](https://github.com/AsamK/signal-cli),
a separately installed, GPL-licensed program that runs as a local daemon. Hearth ships none
of its code; it only uses the daemon's documented HTTP JSON-RPC API:

| Endpoint              | Used for                                                       |
| --------------------- | -------------------------------------------------------------- |
| `GET  /api/v1/check`  | "Is the daemon up?" before connecting                          |
| `POST /api/v1/rpc`    | every command (send, react, list groups, link device, …)       |
| `GET  /api/v1/events` | incoming messages as Server-Sent Events, resumable by event id |

## 1. Install signal-cli

signal-cli needs a Java runtime (JRE 25 or newer for current releases) unless you use the
native Linux build. Follow the upstream
[installation guide](https://github.com/AsamK/signal-cli#installation), for example:

```sh
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} \
  https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}.tar.gz"
sudo tar xf "signal-cli-${VERSION}.tar.gz" -C /opt
sudo ln -sf "/opt/signal-cli-${VERSION}/bin/signal-cli" /usr/local/bin/
signal-cli --version
```

Signal changes its servers regularly; releases older than about three months may stop
working. Keep signal-cli up to date.

## 2. Start the daemon (multi-account mode)

```sh
signal-cli daemon --http 127.0.0.1:8080
```

- Start it **without** `-a/--account`. In this multi-account mode Hearth can list your
  accounts and link a new device itself (`startLink` / `finishLink`). If you do pass
  `-a +15551234567`, everything still works except linking from inside Hearth.
- Keep the address on `127.0.0.1` (see [Privacy](#privacy)).
- Optional: `--sse-keepalive-interval 15` (the default). Hearth treats a connection that
  is silent for 45 s as dead and reconnects, so don't raise it above ~30 s.
- Attachments are downloaded by the daemon (don't pass `--ignore-attachments` if you want
  to see images). Hearth fetches the bytes lazily, only when an attachment is on screen.

Check it:

```sh
curl -i http://127.0.0.1:8080/api/v1/check        # HTTP/1.1 200 OK
```

## 3. Start Hearth

```sh
npm install
npm run dev                                  # proxies /signal-cli → 127.0.0.1:8080
HEARTH_SIGNAL_CLI_URL=http://127.0.0.1:9000 npm run dev   # daemon elsewhere
```

`HEARTH_SIGNAL_CLI_URL` can also be put in `.env.local`. `npm run preview` (the production
build) sets up the same proxy.

Open the app and choose **Connect to signal-cli**. The daemon URL defaults to
`/signal-cli` — the _browser-side_ address of the dev proxy. You normally never change it:
the daemon sends no CORS headers and only accepts requests whose `Host` header matches its
bind address, so the browser must go through the same-origin proxy (which rewrites `Host`).

## 4. Link this device

If the daemon has no account yet, Hearth offers **Link this device**:

1. Hearth calls `startLink` and shows a QR code (`sgnl://linkdevice?...`).
2. On your phone: **Signal → Settings → Linked devices → +**, then scan the code.
3. Hearth waits on `finishLink` (up to 10 minutes), remembers the new account and syncs.

The same thing from a terminal, if you prefer (stop the daemon first, restart it and reload
Hearth afterwards):

```sh
signal-cli link -n "Hearth"        # prints sgnl://linkdevice?... and waits for the scan
# in another terminal, render that URI as a QR code, e.g.:
qrencode -t ansiutf8 'sgnl://linkdevice?uuid=…&pub_key=…'
```

With several accounts on one daemon, Hearth uses the one stored in settings
(`connection.account`, an ACI or phone number) or, if unset, the first account it finds.

## What to expect

- **History starts now.** signal-cli keeps no message history, so Hearth shows messages
  received while it (or the daemon's event buffer) was running, and stores them locally in
  IndexedDB (`hearth-signal-cli`). The daemon keeps the last 1000 events in memory; if
  Hearth was closed (or reloaded) while the daemon kept running, it resumes from the last
  event it saw.
- **Direct conversations** appear once a message is exchanged; groups appear immediately.
- Stickers, view-once media, payments, polls and shared contacts are shown as a short note
  ("open it on your phone"); calls and stories are ignored.
- Group updates are shown as a system line computed by comparing the group before and
  after (signal-cli does not say what changed).

## Troubleshooting

| Symptom                                                           | Cause / fix                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Cannot reach signal-cli at /signal-cli"                          | Daemon not running, wrong port, or `HEARTH_SIGNAL_CLI_URL` points elsewhere. `curl http://127.0.0.1:8080/api/v1/check`. Restart `npm run dev` after changing the env var. |
| "Daemon rejected the Host header" (HTTP 421)                      | You're calling the daemon directly or through a proxy that keeps the browser's `Host`. Use the default `/signal-cli` URL.                                                 |
| "signal-cli has no account yet"                                   | Link a device (step 4) or register one with `signal-cli -a +NUMBER register`.                                                                                             |
| Stream stays "connecting" / status "error" right after connecting | The event stream answered 400: the configured account doesn't exist on this daemon. Clear the account in settings (Advanced → Connection) or fix it.                      |
| Messages from before Hearth was opened are missing                | Expected: signal-cli has no history, and its event buffer is lost when the daemon restarts. Keep the daemon running (e.g. as a user service).                             |
| Sends fail with "untrusted identity"                              | A contact's safety number changed. Verify it on your phone, or `signal-cli -a ACCOUNT trust -a NUMBER`.                                                                   |
| Sends fail with "rate limited"                                    | Signal throttles new/linked devices; wait (the error includes the retry delay) or solve the captcha challenge with `submitRateLimitChallenge`.                            |
| Images never load                                                 | The daemon was started with `--ignore-attachments`, or the file is larger than 100 MB (open it on your phone).                                                            |
| Everything is slow after a daemon restart                         | On reconnect with an unknown event id the daemon replays up to 1000 buffered events; duplicates are merged, it settles within seconds.                                    |

## Privacy

- **Bind the daemon to localhost.** It has **no authentication**: anyone who can reach the
  port can read and send your messages. Never use `--http 0.0.0.0:…` (which also disables
  its Host-header check) on a machine others can reach.
- Hearth only talks to the daemon through the local proxy; no other network requests are
  made on its behalf. Link previews are off by default.
- Message history lives in your browser's IndexedDB for the Hearth origin; clear it from
  Settings → Data & Storage, or by clearing site data.
- Outgoing attachments are sent to the daemon as `data:` URIs (never as file paths), so
  the web page can't make the daemon read arbitrary local files.
