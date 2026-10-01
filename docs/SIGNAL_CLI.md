# Running Shrike against signal-cli

Shrike talks to the Signal network through [signal-cli](https://github.com/AsamK/signal-cli),
a separately installed, GPL-licensed program that runs as a local daemon. Shrike ships none
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

## 2. Start the daemon

```sh
signal-cli daemon --http 127.0.0.1:8080 --receive-mode on-connection
```

- **Multi-account mode (recommended):** start it **without** `-a/--account`. Shrike then
  lists your accounts (`listAccounts`) and can link a new device itself
  (`startLink` / `finishLink`).
- **Single-account mode** (`signal-cli -a +15551234567 daemon --http …`) also works, but
  this daemon can't tell Shrike which account it serves and has no linking methods: Shrike
  asks you for the account's phone number (or ACI) once, and linking must be done in a
  terminal (step 4). Shrike learns the matching ACI from incoming events automatically.
- `--receive-mode on-connection` makes the daemon fetch messages from Signal only while
  Shrike is connected, so messages that arrive while Shrike is closed wait on Signal's
  servers instead of being consumed by the daemon unseen. With the default `on-start`, the
  daemon receives from the moment it starts, and anything it receives before Shrike first
  connects is not buffered for Shrike (its event buffer starts recording on the first
  event-stream connection).
- Keep the address on `127.0.0.1` (see [Privacy](#privacy)).
- Optional: `--sse-keepalive-interval 15` (the default). Shrike treats a connection that
  is silent for 45 s as dead and reconnects, so don't raise it above ~30 s.
- Attachments are downloaded by the daemon (don't pass `--ignore-attachments` if you want
  to see images). Shrike fetches the bytes lazily, only when an attachment is on screen.

Check it:

```sh
curl -i http://127.0.0.1:8080/api/v1/check        # HTTP/1.1 200 OK
```

## 3. Start Shrike

```sh
npm install
npm run dev                                  # proxies /signal-cli → 127.0.0.1:8080
SHRIKE_SIGNAL_CLI_URL=http://127.0.0.1:9000 npm run dev   # daemon elsewhere
```

`SHRIKE_SIGNAL_CLI_URL` can also be put in `.env.local`. `npm run preview` (the production
build) sets up the same proxy.

Open the app and choose **Connect to signal-cli**. The daemon URL defaults to
`/signal-cli` — the _browser-side_ address of the dev proxy. You normally never change it:
the daemon sends no CORS headers and only accepts requests whose `Host` header matches its
bind address, so the browser must go through the same-origin proxy (which rewrites `Host`).

## 4. Link this device

If the daemon has no account yet, Shrike offers **Link this device**:

1. Shrike calls `startLink` and shows a QR code (`sgnl://linkdevice?...`).
2. On your phone: **Signal → Settings → Linked devices → +**, then scan the code.
3. Shrike waits on `finishLink` (up to 10 minutes), remembers the new account and syncs.

The same thing from a terminal, if you prefer (stop the daemon first, restart it and reload
Shrike afterwards):

```sh
signal-cli link -n "Shrike"        # prints sgnl://linkdevice?... and waits for the scan
# in another terminal, render that URI as a QR code, e.g.:
qrencode -t ansiutf8 'sgnl://linkdevice?uuid=…&pub_key=…'
```

With several accounts on one daemon, Shrike uses the one stored in settings
(`connection.account`, an ACI or phone number) or, if unset, the first account it finds.
On a single-account daemon `connection.account` is required (Shrike reports
`account-required` until it is set).

## What to expect

- **History starts now.** signal-cli keeps no message history, so Shrike shows messages
  received while it (or the daemon's event buffer) was running, and stores them locally in
  IndexedDB (`shrike-signal-cli`). The daemon keeps the last 1000 events in memory; if
  Shrike is reloaded while the daemon keeps running, it resumes after the last event it
  had _stored_ (the position is saved only after the message is written locally, so a
  reload can re-deliver, never skip).
- **Direct conversations** appear once a message is exchanged; groups appear immediately.
- Stickers, view-once media, payments, polls and shared contacts are shown as a short note
  ("open it on your phone"); calls and stories are ignored. Messages the daemon couldn't
  decrypt (e.g. a changed safety number) appear as a system line asking you to check the
  safety number on your phone.
- Group updates are shown as a system line computed by comparing the group before and
  after (signal-cli does not say what changed). Several updates in a row are summarised
  in one line without naming who did what.
- Your own sent images keep only a small (≤ 512 px) preview locally; files over 100 MB
  can't be sent or opened through the daemon.
- **Edits** re-send the original reply quote (signal-cli rebuilds the whole message from
  the edit's parameters). Attachments can't be re-sent with an edit; official Signal
  clients keep the original's attachments, but this is unverified with signal-cli.
- Changing a **1:1 disappearing-message timer** uses `updateContact`, which also un-hides
  the contact if you had hidden it on your phone.
- The first connection may take a while on large accounts: listing contacts makes the
  daemon refresh stale profiles from Signal's servers. Shrike connects and receives
  messages meanwhile; names fill in when the list arrives.

## Troubleshooting

| Symptom                                                               | Cause / fix                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Cannot reach signal-cli at /signal-cli"                              | Daemon not running, wrong port, or `SHRIKE_SIGNAL_CLI_URL` points elsewhere. `curl http://127.0.0.1:8080/api/v1/check`. Restart `npm run dev` after changing the env var.                                                                                                                           |
| "Daemon rejected the Host header" (HTTP 421)                          | You're calling the daemon directly or through a proxy that keeps the browser's `Host`. Use the default `/signal-cli` URL.                                                                                                                                                                           |
| "signal-cli has no account yet"                                       | Link a device (step 4) or register one with `signal-cli -a +NUMBER register`.                                                                                                                                                                                                                       |
| "This signal-cli daemon serves a single account" (`account-required`) | The daemon was started with `-a`. Enter that account's number in Shrike, or restart the daemon without `-a` (multi-account mode).                                                                                                                                                                   |
| HTTP 403 "Forbidden: …" from `/signal-cli`                            | The dev proxy only serves the app's own origin on a loopback address. Open Shrike at `http://localhost:5173` (not a LAN address) and don't call the proxy from other sites.                                                                                                                         |
| Stream stays "connecting" / status "error" right after connecting     | The event stream answered 400: the configured account doesn't exist on this daemon. Clear the account in settings (Advanced → Connection) or fix it.                                                                                                                                                |
| Messages from before Shrike was opened are missing                    | signal-cli has no history. Messages from before linking are never available. With the default `--receive-mode on-start`, messages the daemon received before Shrike's first connection (since the daemon started) are not buffered for Shrike; use `--receive-mode on-connection`.                  |
| Sends fail with "untrusted identity"                                  | A contact's safety number changed. Verify it on your phone, or `signal-cli -a ACCOUNT trust -a NUMBER`.                                                                                                                                                                                             |
| Sends fail with "rate limited"                                        | Signal throttles new/linked devices; wait (the error includes the retry delay) or solve the captcha challenge with `submitRateLimitChallenge`.                                                                                                                                                      |
| Images never load                                                     | The daemon was started with `--ignore-attachments`, or the file is larger than 100 MB (open it on your phone).                                                                                                                                                                                      |
| A burst of old messages right after reconnecting                      | Shrike resumed with a saved event id the daemon doesn't know (it was restarted), so the daemon sent every event it has buffered since it started (at most 1000). Duplicates of messages Shrike already has are merged. If more than 1000 events arrived while Shrike was away, the oldest are gone. |

## Privacy

- **Bind the daemon to localhost.** It has **no authentication**: anyone who can reach the
  port can read and send your messages. Never use `--http 0.0.0.0:…` (which also disables
  its Host-header check) on a machine others can reach.
- **Don't expose the dev server.** The proxy forwards to the daemon with the daemon's own
  Host header, so it is exactly as powerful as the daemon. Shrike's proxy guard only answers
  requests for a loopback Host from the app's own origin (checked via `Origin` and
  `Sec-Fetch-Site`), and CORS is disabled on the dev/preview server, so other web pages —
  including other `localhost` apps — can't use it. Running `vite --host` (or `npm run dev -- --host`) puts the server on your network: the
  guard then refuses LAN requests, but don't work around it, and never run the proxy on a
  shared machine.
- Shrike only talks to the daemon through the local proxy; no other network requests are
  made on its behalf. Link previews are off by default.
- Message history lives in your browser's IndexedDB for the Shrike origin; clear it from
  Settings → Data & Storage, or by clearing site data.
- Outgoing attachments are sent to the daemon as `data:` URIs (never as file paths, and
  never empty — an empty data URI would be read as a path by signal-cli), so the web page
  can't make the daemon read arbitrary local files.
- Incoming attachments are handed to the page as `blob:` URLs typed with their real media
  type only for common raster image, audio and video types; anything else (HTML, SVG, …)
  is served as opaque bytes so it can never run as a page.
