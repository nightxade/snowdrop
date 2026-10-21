# Running Snowdrop against signal-cli

> This page is about a signal-cli **HTTP daemon** you run yourself. It applies to
> **browser mode** and to the desktop app's **external-daemon mode** (Settings →
> Connection). The desktop app's default mode needs none of this: it bundles
> signal-cli and runs it directly, with no daemon to install or start. See
> [DESKTOP.md](DESKTOP.md).

Snowdrop talks to the Signal network through [signal-cli](https://github.com/AsamK/signal-cli),
a separately installed, GPL-licensed program that runs as a local daemon. Snowdrop ships none
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

- **Multi-account mode (recommended):** start it **without** `-a/--account`. Snowdrop then
  lists your accounts (`listAccounts`) and can link a new device itself
  (`startLink` / `finishLink`).
- **Single-account mode** (`signal-cli -a +15551234567 daemon --http …`) also works, but
  this daemon can't tell Snowdrop which account it serves and has no linking methods: Snowdrop
  asks you for the account's phone number (or ACI) once, and linking must be done in a
  terminal (step 4). Snowdrop learns the matching ACI from incoming events automatically.
- `--receive-mode on-connection` makes the daemon fetch messages from Signal only while
  Snowdrop is connected, so messages that arrive while Snowdrop is closed wait on Signal's
  servers instead of being consumed by the daemon unseen. With the default `on-start`, the
  daemon receives from the moment it starts, and anything it receives before Snowdrop first
  connects is not buffered for Snowdrop (its event buffer starts recording on the first
  event-stream connection).
- Keep the address on `127.0.0.1` (see [Privacy](#privacy)).
- Optional: `--sse-keepalive-interval 15` (the default). Snowdrop treats a connection that
  is silent for 45 s as dead and reconnects, so don't raise it above ~30 s.
- Attachments are downloaded by the daemon (don't pass `--ignore-attachments` if you want
  to see images). Snowdrop fetches the bytes lazily, only when an attachment is on screen.

Check it:

```sh
curl -i http://127.0.0.1:8080/api/v1/check        # HTTP/1.1 200 OK
```

## 3. Start Snowdrop

```sh
npm install
npm run dev                                  # proxies /signal-cli → 127.0.0.1:8080
SNOWDROP_SIGNAL_CLI_URL=http://127.0.0.1:9000 npm run dev   # daemon elsewhere
```

`SNOWDROP_SIGNAL_CLI_URL` can also be put in `.env.local`. `npm run preview` (the production
build) sets up the same proxy.

Open the app and choose **Connect to signal-cli**. The daemon URL defaults to
`/signal-cli` — the _browser-side_ address of the dev proxy. You normally never change it:
the daemon sends no CORS headers and only accepts requests whose `Host` header matches its
bind address, so the browser must go through the same-origin proxy (which rewrites `Host`).

## 4. Link this device

If the daemon has no account yet, Snowdrop offers **Link this device**:

1. Snowdrop calls `startLink` and shows a QR code (`sgnl://linkdevice?...`).
2. On your phone: **Signal → Settings → Linked devices → +**, then scan the code.
3. Snowdrop waits on `finishLink` (up to 10 minutes), remembers the new account and syncs.

The same thing from a terminal, if you prefer (stop the daemon first, restart it and reload
Snowdrop afterwards):

```sh
signal-cli link -n "Snowdrop"        # prints sgnl://linkdevice?... and waits for the scan
# in another terminal, render that URI as a QR code, e.g.:
qrencode -t ansiutf8 'sgnl://linkdevice?uuid=…&pub_key=…'
```

With several accounts on one daemon, Snowdrop uses the one stored in settings
(`connection.account`, an ACI or phone number) or, if unset, the first account it finds.
On a single-account daemon `connection.account` is required (Snowdrop reports
`account-required` until it is set).

## What to expect

- **History starts now.** signal-cli keeps no message history, so Snowdrop shows messages
  received while it (or the daemon's event buffer) was running, and stores them locally in
  IndexedDB (`snowdrop-signal-cli`). The daemon keeps the last 1000 events in memory; if
  Snowdrop is reloaded while the daemon keeps running, it resumes after the last event it
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
  daemon refresh stale profiles from Signal's servers. Snowdrop connects and receives
  messages meanwhile; names fill in when the list arrives.

## Troubleshooting

| Symptom                                                               | Cause / fix                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Cannot reach signal-cli at /signal-cli"                              | Daemon not running, wrong port, or `SNOWDROP_SIGNAL_CLI_URL` points elsewhere. `curl http://127.0.0.1:8080/api/v1/check`. Restart `npm run dev` after changing the env var.                                                                                                                               |
| "Daemon rejected the Host header" (HTTP 421)                          | You're calling the daemon directly or through a proxy that keeps the browser's `Host`. Use the default `/signal-cli` URL.                                                                                                                                                                                 |
| "signal-cli has no account yet"                                       | Link a device (step 4) or register one with `signal-cli -a +NUMBER register`.                                                                                                                                                                                                                             |
| "This signal-cli daemon serves a single account" (`account-required`) | The daemon was started with `-a`. Enter that account's number in Snowdrop, or restart the daemon without `-a` (multi-account mode).                                                                                                                                                                       |
| HTTP 403 "Forbidden: …" from `/signal-cli`                            | The dev proxy only serves the app's own origin on a loopback address. Open Snowdrop at `http://localhost:5173` (not a LAN address) and don't call the proxy from other sites.                                                                                                                             |
| Stream stays "connecting" / status "error" right after connecting     | The event stream answered 400: the configured account doesn't exist on this daemon. Clear the account in settings (Advanced → Connection) or fix it.                                                                                                                                                      |
| Messages from before Snowdrop was opened are missing                  | signal-cli has no history. Messages from before linking are never available. With the default `--receive-mode on-start`, messages the daemon received before Snowdrop's first connection (since the daemon started) are not buffered for Snowdrop; use `--receive-mode on-connection`.                    |
| Sends fail with "untrusted identity"                                  | A contact's safety number changed. Verify it on your phone, or `signal-cli -a ACCOUNT trust -a NUMBER`.                                                                                                                                                                                                   |
| Sends fail with "rate limited"                                        | Signal throttles new/linked devices; wait (the error includes the retry delay) or solve the captcha challenge with `submitRateLimitChallenge`.                                                                                                                                                            |
| Images never load                                                     | The daemon was started with `--ignore-attachments`, or the file is larger than 100 MB (open it on your phone).                                                                                                                                                                                            |
| A burst of old messages right after reconnecting                      | Snowdrop resumed with a saved event id the daemon doesn't know (it was restarted), so the daemon sent every event it has buffered since it started (at most 1000). Duplicates of messages Snowdrop already has are merged. If more than 1000 events arrived while Snowdrop was away, the oldest are gone. |

## Privacy

- **Bind the daemon to localhost.** It has **no authentication**: anyone who can reach the
  port can read and send your messages. Never use `--http 0.0.0.0:…` (which also disables
  its Host-header check) on a machine others can reach.
- **Don't expose the dev server.** The proxy forwards to the daemon with the daemon's own
  Host header, so it is exactly as powerful as the daemon. Snowdrop's proxy guard only answers
  requests for a loopback Host from the app's own origin (checked via `Origin` and
  `Sec-Fetch-Site`), and CORS is disabled on the dev/preview server, so other web pages —
  including other `localhost` apps — can't use it. Running `vite --host` (or `npm run dev -- --host`) puts the server on your network: the
  guard then refuses LAN requests, but don't work around it, and never run the proxy on a
  shared machine.
- Snowdrop only talks to the daemon through the local proxy, with one exception: link
  previews (on by default). Composing a message with a link fetches that page's title,
  description and image directly from this device, which reveals your IP to the site —
  visible before you send, and can be turned off in Settings → Behaviour.
- Message history lives in your browser's IndexedDB for the Snowdrop origin; clear it from
  Settings → Data & Storage, or by clearing site data.
- Outgoing attachments are sent to the daemon as `data:` URIs (never as file paths, and
  never empty — an empty data URI would be read as a path by signal-cli). The desktop app
  enforces this in Rust (`src-tauri/src/rpc_guard.rs`): a `signal_cli_request` whose
  `attachment`, `previewImage`, `avatar` or `customEmoji[].attachment` isn't a `data:` URI,
  or whose `quoteAttachment` has a third (preview-file) segment, is rejected before it
  reaches signal-cli, so the page can't make the daemon read a local file. This guard is
  the only protection: signal-cli itself reads any other string as a path (it only blocks
  its own data directory). In the browser build (dev proxy to a daemon you run) nothing
  enforces it, and the page can ask the daemon to read any file the daemon can.
- Incoming attachments are handed to the page as `blob:` URLs typed with their real media
  type only for common raster image, audio and video types; anything else (HTML, SVG, …)
  is served as opaque bytes so it can never run as a page.

## Experimental phone-history patch

The separately licensed [patch series](../patches/signal-cli/README.md) adds
phone-history transfer during a fresh link and a paginated `getHistory` command
to signal-cli 0.14.8. The phone decides whether to transfer history. This does
not retroactively fill existing linked accounts. Snowdrop now discovers the
optional archive, merges its directory, and pages supported messages into local
history without emitting arrival notifications. Stock signal-cli remains usable
without those methods. Read-time timer updates are connected to focused, visible
message rows. Startup recovers saved deadlines without starting unread timers.
A synthetic Chromium check loaded 63 archived messages across pages with no
duplicates or historical notifications, opened a sticker in the image viewer,
and started a pending timer only after viewing. A failed history transfer now
shows a persistent warning after linking, with an option to continue using the
linked account. Real-phone transfer remains unverified.
When a cached boundary has no archive cursor, paging first locates its message
identity in the archive so skewed sender clocks do not change the join position.
This initial lookup may scan the chat's archive; subsequent pages use saved
ordinal cursors directly. If the boundary is absent from the archive, paging
falls back to its sender timestamp. Arbitrary gaps within an existing cache
are not filled by this older-history paging path.
See the patch README for build instructions and known limitations.

Local verification includes the 1,441 frontend tests and 246 native tests
(socket-dependent tests rerun outside the sandbox; notification and clipboard
tests use isolated sessions). The patched CLI passes 44 history tests. Synthetic
browser checks cover archive paging, media viewing, notification suppression,
read-time expiration, and continuing after a history-transfer failure. These
checks do not verify a real phone transfer or real attachment CDN availability.

## Sticker packs: install one from a received sticker

Clicking a received sticker (or its "View sticker pack" menu item) opens a dialog with the
pack's cover, title, author and every sticker, and an Install button. Installing is the user's own
explicit action and, like Signal's own "Install", is synced to their phone; nothing is ever
installed implicitly. The pack key never reaches the TypeScript side: Snowdrop names the pack
by its hex id (`installKnownStickerPack`, patch 0021) and signal-cli looks the key up in its own
sticker store, where a live-received sticker or a history sticker (patch 0019, registered first)
has already put it. On a build without 0021 (`supportsStickerPackInstall` is false, patch level
below 17) the dialog still shows the pack, with Install disabled and a note. After an install the
composer's sticker picker lists the pack without a restart.

## Custom emoji from other people

An emoji someone else delivered with a message (see below) can be added to your own collection:
click it inline in their message (or use the message's "Add :name: to my emoji" menu item). The
image is read through the same `getAttachment` path (`readAttachmentBlob`: bytes, not a `blob:` URL,
which the app's CSP can't fetch) and goes through exactly the checks of an image picked in
Settings → Custom emoji: at most 256 KB, PNG/JPEG/GIF/WebP, at most 1024 × 1024 pixels, a valid name,
and a free slot. If the name is taken by a _different_ image, the card offers a rename (never an
overwrite); if the same image is already in the collection, it says so. Nothing is uploaded or sent.

## Custom emoji: `:name:` text, with Snowdrop-to-Snowdrop delivery on a patched signal-cli

Custom emoji (Settings → Custom emoji, or the composer's "My emoji" tab) are typed or
inserted as plain `:name:` text — the text is all that's in a message's visible body.
Snowdrop renders a resolvable `:name:` inline as the emoji's image, at emoji size (jumbo if
the whole message is emoji, matching the rule for standard emoji — see `isJumbo` in
`src/ui/features/chat/message/MessageBody.tsx`).

Against a signal-cli built from this repo's patches (`patches/signal-cli`, patch 0013, and
its enabling `patches/signal-service-java` hook), the emoji's image is delivered too: when the
outgoing text contains `:name:` tokens matching the sender's own collection, Snowdrop uploads
each one's image as a normal encrypted attachment and the message carries `{name, attachment}`
pairs on an _unknown_ DataMessage field (9000). Official Signal clients, and any unpatched
signal-cli, silently ignore unknown fields — they still see only the `:name:` text. A Snowdrop
peer on a patched signal-cli decodes the field and renders the image inline, for that message
only; **own messages still resolve `:name:` from the viewer's own collection** (what they're
about to send, or already sent), and **received messages resolve only from that specific
message's own delivered emoji** — never the viewer's local collection, which has nothing to do
with what the sender used. Works in 1:1 chats, groups, and edits.

Capability detection is one pure function,
`src/core/backend/signal-cli/capabilities.ts` (`supportsCustomEmojiDelivery`): it checks the
connected daemon's own version string (fetched once at connect, via the `version` JSON-RPC
method) for a `snowdrop-history.N` patch level of at least 11. Against upstream signal-cli, an
older patched build, or the demo backend, this is false, and Snowdrop sends (and received
messages can only ever carry) plain `:name:` text — the exact behaviour this feature had before
patch 0013 existed, with no change in UI or data shape.

See `patches/signal-cli/README.md`'s "Custom emoji" section for the wire shape, the JSON-RPC
`send`/`sendEditMessage` `customEmoji` param, and the `MessageEnvelope.Data.customEmoji`
receive shape this builds on; `patches/signal-service-java/README.md` for the one generic hook
(`SignalServiceDataMessage.Builder#withUnknownFields`) that made sending possible at all — the
public send API otherwise only accepts a `SignalServiceDataMessage` with no unknown-field slot,
and the raw-`Content` escape hatch (`resendContent`) has no group-send equivalent.
