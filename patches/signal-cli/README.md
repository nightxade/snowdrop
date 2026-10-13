# signal-cli history patch

Base: upstream tag `v0.14.8`, commit
`22b028bbb9cee8f6aa22af71c6b3e9d09028a16a`.

These patches target the separate GPL-3.0-or-later signal-cli process. They are
not compiled into Snowdrop's frontend or native shell. New Java files in the
patch are licensed GPL-3.0-or-later as marked by their SPDX headers. The second
patch includes Signal’s AGPL-3.0-only backup schema and synthetic test fixture,
with upstream attribution, pinned source commits, and license text.

Apply to a clean checkout of the pinned upstream commit:

```sh
git apply /path/to/snowdrop/patches/signal-cli/*.patch
./gradlew test --tests '*HistoryCommandTest' :libsignal-cli:test --tests '*History*Test'
./gradlew installDist
```

`scripts/build-signal-cli.sh` (repo root) automates exactly that — clone,
checkout, patch, `installDist` — and then goes one step further: it jlinks a
minimal, self-contained Java runtime around the result (a fixed module list
in the script — `jdeps` can't resolve this jar set, and the TLS providers,
sqlite JDBC and libsignal's JNI bridge are only reached at runtime), so the
output needs no system Java at all to run. It writes everything under this
directory's own gitignored `.work/` (the clone + Gradle build tree) and
`dist/` (the finished runtime):

```sh
npm run signal-cli:build            # patches/signal-cli/dist/signal-cli/{bin,lib,runtime}
npm run signal-cli:build -- --test  # same, running the history test suite first
npm run signal-cli:install          # build (if dist/ isn't already there) and install it
```

`dist/signal-cli/bin/signal-cli` is a small launcher script, not the JVM
start script directly: it resolves its own real location, points
`JAVA_HOME` at the jlinked `runtime/` next to it, and execs the original
Gradle start script (kept alongside as `bin/signal-cli.gradle`). `npm run
signal-cli:install` copies that whole directory, atomically, into
`<app data dir>/bin/signal-cli-history/` (`${XDG_DATA_HOME:-~/.local/share}/
local.snowdrop.desktop/bin/signal-cli-history/` on Linux; the previous install is kept as `signal-cli-history.previous/`; override with
`SNOWDROP_APP_DATA`, which is how to test an install into a scratch
directory without touching the real one) — the desktop app prefers a
binary there over its own downloaded or bundled copy (`src-tauri/src/
config.rs`, `BinarySource::Patched`; see docs/DESKTOP.md's "Resolution
order"). The script requires `SNOWDROP_JDK` to point at a JDK 25 home
(`java -version` must report 25 under it) and reads `SIGNAL_CLI_SRC` for
the clone source (default: upstream's GitHub repo; a local path works too).
`dist/signal-cli/PROVENANCE.txt` records the upstream commit, each applied
patch's SHA-256, the JDK version, and the build date.

Requires JDK 25. The first patch adds the authenticated archive decoder and its
regression tests. The second patch adds protobuf decoding and JSON conversion
that preserve expiration fields and exact 64-bit IDs, plus an official Signal
fixture test. The third patch adds transactional storage in the account database
and a `getHistory` CLI/JSON-RPC command. It builds as
`0.14.8-snowdrop-history.8`. The fourth patch advertises history-transfer
support during linking, respects the phone’s transfer choice, polls the
authenticated transfer endpoint, and imports the encrypted download. Temporary
archives and working key arrays are cleared after import. Transfer failures are
reported through the link result while keeping the linked account usable;
retrying requires a fresh link.
Existing linked accounts do not gain older history automatically.

The distribution builds locally and all 44 history tests pass, including an
encrypted-download-to-retrieval fixture. A real-phone transfer has not been
verified. Upstream bundles only a Linux x86-64 JNI library. The local build at
`dist/signal-cli/bin/signal-cli` also includes a Linux ARM64 JNI library built
from official libsignal **v0.102.1**, matching its Java dependency. Native
identity-key generation and archive-key derivation pass in local testing without
accessing an account. The ignored `dist/` directory contains build provenance
and source archives; Java 25 is still required.

To reproduce ARM64 support, build `libsignal-jni` from that exact libsignal tag
with `cargo build --release --locked -p libsignal-jni` (requires Rust, a C/C++
toolchain and `protoc`, including its standard protobuf includes). Either pass
`-Djava.library.path=/path/to/libsignal/target/release` in `JAVA_OPTS`, or add
`libsignal_jni.so` to `libsignal-client-0.102.1.jar` as
`libsignal_jni_aarch64.so`. Do not mix JNI and Java library versions.

The decoder follows the link-and-sync framing: 16-byte IV, AES-256-CBC
ciphertext containing padded gzip data, then a 32-byte HMAC-SHA256 over the IV
and ciphertext. It validates the HMAC before decoding. Plaintext consists of
varint-length-prefixed protobufs: BackupInfo followed by Backup Frames. Keys
must come from libsignal's MessageBackupKey derivation using the ephemeral
provisioning key and account ACI. Callers must supply an immutable private
download and import transactionally, committing only on successful completion.

Verification and limits:

- Conversion covers standard
  messages, stickers, shared contacts, polls, story replies, payments/gifts, and
  known chat updates. Phone-only actions are identified as such. Unknown future
  variants are skipped according to the backup schema.
- Synthetic browser checks verify paging, sticker viewing, read-time timers,
  notification suppression, and continuation after a transfer failure. Snowdrop
  loads the archive directory, pages supported messages using persisted cursors,
  and applies read-time expiration for focused, visible message rows. Fetching
  history emits no message-arrival events.
- Older-history paging does not fill arbitrary gaps within an existing local
  message cache; the archive retrieval API exposes those frames separately.
- Real-phone transfer remains unverified. The optional
  manual procedure below is available for later testing.

Protocol references:
[Signal's link-and-sync explanation](https://signal.org/blog/a-synchronized-start-for-linked-devices/),
[Signal Desktop backup importer](https://github.com/signalapp/Signal-Desktop/blob/main/ts/services/backups/index.preload.ts),
[Signal backup protobuf schema](https://github.com/signalapp/Signal-Desktop/blob/main/protos/Backups.proto).

## Retrieval contract

```sh
signal-cli -a ACCOUNT --output=json getHistory --limit 100
signal-cli -a ACCOUNT --output=json getHistory --archive-id SNAPSHOT --after CURSOR --limit 100
```

JSON-RPC uses method `getHistory` with `archiveId`, `after`, and `limit`.
The result is `{archiveId, entries: [{cursor, frame}], nextCursor, hasMore}`.
Frames use the backup protobuf's JSON field names. Uint64 values and cursors
are decimal strings. Frames retain backup ordering (recipients before chats,
chats before their messages). Account settings/keys are not returned. This is
an imported archive snapshot, not a log of messages received after import.

A new import replaces the snapshot atomically; a failed import rolls back.
Clients must pass the returned archive ID on subsequent pages. If it changes,
restart pagination. Expired messages are skipped on import and purged before
retrieval. The tables live inside the existing account database, so Snowdrop's
SQLite vault snapshot includes them.

## Indexed queries for Snowdrop integration

The fifth patch adds `getHistoryDirectory` and `getHistoryChat` without changing
`getHistory`. Indexes are derived from the original frames, built lazily for
older snapshots, and replaced when the archive changes. Expiration purges both
message frames and their index entries.

`getHistoryDirectory` accepts `archiveId`, `after`, and `limit` like `getHistory`,
but returns only recipient and chat frames. `getHistoryChat` accepts
`archiveId`, `chatId` (an archive-local decimal string), optional `before` (an
exclusive ordinal cursor), and `limit`. It returns the newest matching page,
with its entries in ascending archive order; `nextCursor` identifies the oldest
entry in that page. Pass it as `before` to retrieve the preceding page.

Both return the existing `{archiveId, entries, nextCursor, hasMore}` shape.
These cursors preserve the phone's archive order, including equal or skewed
sender timestamps. They are not timestamps or Snowdrop's local sequence numbers.

The sixth patch adds `signalGroupId` alongside group recipient frames returned
by `getHistoryDirectory`. It derives the canonical group ID from the archived
master key using the matching libsignal version. Snowdrop can therefore join
archived messages to the same group used by live messages. Raw `getHistory`
frames are unchanged. Invalid group keys fail directory retrieval explicitly.
The new regression test uses libsignal JNI; ARM64 test runs need the matching
native library on `java.library.path` as described above.

## History attachments

The seventh patch extends the existing `getAttachment` RPC to recognize
`history:<archiveId>:<frameCursor>:attachment:<zeroBasedIndex>` IDs. It resolves
the pointer from the selected account's current snapshot and downloads it from
Signal's transit CDN using the existing Signal library. Keys are not accepted
from the caller. The response remains `{data: BASE64}` like ordinary attachments.

Only current supported-message attachments are downloadable. Deleted messages,
view-once media, revision content, expired messages, and replaced snapshots are
rejected. Expiration and snapshot identity are checked again after downloading.
Both plaintext hashes and encrypted digests are verified; temporary files are
removed after success or failure. The plaintext limit is 100 MiB, matching
Snowdrop's attachment API limit.

Attachments unavailable from transit storage cannot currently be restored from
Signal's media-backup tier. Missing locators or expired CDN objects report an
error; the patch does not substitute unverified data. Synthetic tests cover
lookup restrictions, both encrypted integrity formats, wrong hashes, and cleanup.
A real phone/CDN transfer remains unverified.

## Starting disappearing timers on read

The eighth patch adds `readHistory` with `{archiveId, cursors: ["3", "4"]}`.
It accepts 1–500 positive decimal-string message cursors and returns
`[{cursor, expiresAt, unavailable}]`. Expiration timestamps are decimal strings;
`expiresAt` is null for messages without an active timer. Missing or expired
messages return `unavailable: true` rather than being recreated.

Call this only when the user reads a message, never during import or prefetch.
The command marks incoming archive messages read and starts unstarted timers
using signal-cli's clock. It sends no network read receipts. Existing timers
keep their original deadline. Updates and read flags are committed atomically
to the archive, so restarts and later pagination cannot reset a timer or restore
an expired message. A changed snapshot or invalid batch fails without partial
updates. Snowdrop's archive client validates the response and connects this
operation to visible-message read tracking.

The ninth patch adds `getHistoryReadState` with the same request and response
shape. It inspects deadlines without marking messages read or starting timers.
Snowdrop uses it before completing initial sync to recover a deadline committed
by signal-cli just before the app exited. Already-expired cached messages are
removed; still-unread timers remain unstarted. Recovery failures prevent initial
sync from exposing potentially expired cache entries. Finding pending timers
currently scans the encrypted local message cache once at startup; no new
plaintext read-state index is stored, but large caches may take longer to open.

## Stickers and long text

The tenth patch adds `sticker:0` and `longText:0` selectors to the same history
attachment ID format. Sticker files come from the current sticker message's
pointer, without exposing its pack key in Snowdrop's message model. Long-text
files can come from standard messages or story replies. Snowdrop retains the
text preview and exposes the full content as a downloadable `message.txt` file.
The same snapshot, expiration, integrity, and size checks apply. A selector
cannot retrieve a different message kind or any deleted/view-once revision.

## Link outcome reporting

The eleventh patch adds `historyTransfer` to the successful `finishLink` result:
`IMPORTED`, `DECLINED`, `UNAVAILABLE`, or `FAILED`. Failure does not turn an
already-linked account into a failed link. Snowdrop keeps a history-import
warning visible until the user continues to conversations and explains that
retrying transfer requires unlinking and linking again. Older signal-cli
builds without this optional field retain the existing link flow.

## Catch-up notification

The twelfth patch adds a `receiveCaughtUp` JSON-RPC notification. signal-cli's
receive loop already tracks `hasCaughtUpWithOldMessages` internally
(`ReceiveHelper`/`ManagerImpl`) but never surfaced it past the process; this
patch adds `Manager.addCaughtUpWithOldMessagesListener`/
`removeCaughtUpWithOldMessagesListener` (mirroring `addReceiveHandler`/
`removeReceiveHandler`) and has `ManagerImpl` call registered listeners
alongside its existing `notifyAll()`. The JSON-RPC dispatcher subscribes one
such listener per manager wherever it already subscribes `receive` (on
connect, and for every `subscribeReceive` call), and sends
`{"jsonrpc":"2.0","method":"receiveCaughtUp","params":{"account":"…"}}` each
time the loop catches up with the server's queue — both on initial connect
and after every reconnect, since `hasCaughtUpWithOldMessages` resets then
fires again. Explicit (non-default) `subscribeReceive` subscriptions get the
same `{"subscription":…,"result":{"account":"…"}}` wrapper as their `receive`
notifications. It carries no envelope payload; clients still read messages
from ordinary `receive` notifications. Builds as
`0.14.8-snowdrop-history.9`.

## User-controlled phone verification

Run this only when ready to add a test device on the phone. It uses a new data
directory and does not read or change the existing signal-cli account files.
The phone must have room for another linked device. This procedure does not
require unlinking the current Snowdrop installation.

From the Snowdrop repository root, with `JAVA_HOME` pointing to JDK 25:

```sh
SNOWDROP_HISTORY_TEST_DIR="$(mktemp -d /tmp/snowdrop-history-phone.XXXXXX)"
patches/signal-cli/dist/signal-cli/bin/signal-cli \
  --config "$SNOWDROP_HISTORY_TEST_DIR" --scrub-log \
  link --name Snowdrop-history-test
```

Run in an interactive terminal so signal-cli renders its QR code. Scan it from
Signal's Linked devices screen and choose history transfer when the phone
offers it. Keep the terminal open while transfer finishes. A successful link
alone is insufficient evidence: the log must also report `IMPORTED` for history.
`DECLINED` means the phone chose to continue without transfer; `FAILED` means
the linked device remains usable but its history was not imported.

After the command exits, inspect a page without printing message contents:

```sh
patches/signal-cli/dist/signal-cli/bin/signal-cli \
  --config "$SNOWDROP_HISTORY_TEST_DIR" --scrub-log --output json \
  getHistory --limit 100 |
  python3 -c 'import json,sys; p=json.load(sys.stdin); print({k: p.get(k) for k in ("archiveId", "nextCursor", "hasMore")}, "frames:", len(p.get("entries", [])))'
```

An archive ID and nonempty frame page establish that retrieval works against
the phone's actual transfer. Check the next page using that archive ID and
`--after` with the returned cursor; its frame cursors must advance. A chat or
attachment comparison still needs local inspection in addition to these
metadata checks. Share only the outcome or error if asking for help; message
contents and the new account directory are unnecessary.

When finished, remove only **Snowdrop-history-test** from the phone's Linked
devices screen. The temporary directory still contains sensitive account and
history data; remove that specific directory after the test device is unlinked
and its data is no longer needed. No cleanup is performed automatically.
