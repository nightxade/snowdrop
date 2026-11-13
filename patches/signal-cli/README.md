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
./gradlew installDist
```

The tests are run by `scripts/build-signal-cli.sh --test`, which runs signal-service-java's tests and
then signal-cli's whole suite (`./gradlew :libsignal-cli:test :test`, unfiltered) in one place, so
there is no test list to keep up to date.

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
npm run signal-cli:build -- --test  # same, running the whole test suite first
npm run signal-cli:install          # build (unless dist/ is current for these sources) and install it
npm run signal-cli:build -- --native # also compile the GraalVM native build (see "The native build")
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
`dist/signal-cli/PROVENANCE.txt` records the upstream commit, the build version, each applied
patch's SHA-256 (both this repo's and signal-service-java's), the SHA-256 of
signal-service-java's publish script and of this build script, the JDK version, and the build
date. `--install` reuses an existing `dist/` only if its provenance matches all of those as they
are on disk now; a new build is smoke-tested before it replaces `dist/`.
`npm run desktop:update` (repo root; see docs/DESKTOP.md) reads that file to
decide whether a rebuild/install is actually needed and drives this script
for you — use it instead of calling `signal-cli:build`/`signal-cli:install`
by hand unless you're debugging the build itself.

Requires JDK 25. The first patch adds the authenticated archive decoder and its
regression tests. The second patch adds protobuf decoding and JSON conversion
that preserve expiration fields and exact 64-bit IDs, plus an official Signal
fixture test. The third patch adds transactional storage in the account database
and a `getHistory` CLI/JSON-RPC command. The build version
(`0.14.8-snowdrop-history.N`, currently `.26`, the first build with the synced message-request answer, synced verification and streamed
`getAttachment` described below (`.26` also carries the signal-service-java `0003` fix that lets SPAM and BLOCK_AND_SPAM reach them), on top of the backfill, link-import, listener, custom-emoji and
multi-account fixes) is set in this one place, a single
`build.gradle.kts` hunk, and recorded in PROVENANCE; raise `N` there whenever the patch set
changes in a way installs must pick up (Snowdrop gates features on it, see the "First shipped"
notes below). The fourth patch advertises history-transfer
support during linking, respects the phone’s transfer choice, polls the
authenticated transfer endpoint, and imports the encrypted download. Temporary
archives and working key arrays are cleared after import. Transfer failures are
reported through the link result while keeping the linked account usable;
retrying requires a fresh link.
Existing linked accounts do not gain older history automatically.

The distribution builds locally and `scripts/build-signal-cli.sh --test` passes (signal-cli: 299 tests, 237 in `:libsignal-cli` and 62 in the root project;
signal-service-java: 637 tests, 7 skipped), including an
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

The fifth patch also adds `signalGroupId` alongside group recipient frames returned
by `getHistoryDirectory`. It derives the canonical group ID from the archived
master key using the matching libsignal version. Snowdrop can therefore join
archived messages to the same group used by live messages. Raw `getHistory`
frames are unchanged. Invalid group keys fail directory retrieval explicitly.
The new regression test uses libsignal JNI; ARM64 test runs need the matching
native library on `java.library.path` as described above.

## History attachments

The sixth patch extends the existing `getAttachment` RPC to recognize
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

The seventh patch adds `readHistory` with `{archiveId, cursors: ["3", "4"]}`.
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

The eighth patch adds `getHistoryReadState` with the same request and response
shape. It inspects deadlines without marking messages read or starting timers.
Snowdrop uses it before completing initial sync to recover a deadline committed
by signal-cli just before the app exited. Already-expired cached messages are
removed; still-unread timers remain unstarted. Recovery failures prevent initial
sync from exposing potentially expired cache entries. Finding pending timers
currently scans the encrypted local message cache once at startup; no new
plaintext read-state index is stored, but large caches may take longer to open.

## Stickers and long text

The ninth patch adds `sticker:0` and `longText:0` selectors to the same history
attachment ID format. Sticker files come from the current sticker message's
pointer, without exposing its pack key in Snowdrop's message model. Long-text
files can come from standard messages or story replies. Snowdrop retains the
text preview and exposes the full content as a downloadable `message.txt` file.
The same snapshot, expiration, integrity, and size checks apply. A selector
cannot retrieve a different message kind or any deleted/view-once revision.

## Link outcome reporting

The fourth patch also adds `historyTransfer` to the successful `finishLink` result:
`IMPORTED`, `DECLINED`, `UNAVAILABLE`, or `FAILED`. Failure (an `IOException` or any runtime
exception from the import) does not turn an already-linked account into a failed link: the
account stays linked and the rest of `finishLink` still runs. Snowdrop keeps a history-import
warning visible until the user continues to conversations and explains that
retrying transfer requires unlinking and linking again. Older signal-cli
builds without this optional field retain the existing link flow.

## Catch-up notification

The tenth patch adds a `receiveCaughtUp` JSON-RPC notification. signal-cli's
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
from ordinary `receive` notifications. A listener's exception, or a listener unsubscribing itself
while the listeners run, cannot disturb the receive loop or the other listeners (they run from a
snapshot). In multi-account mode an account added while the connection is open gets one listener per
subscription, not two (every notification used to reach the default subscription twice for it).
First shipped as build `0.14.8-snowdrop-history.9`.

## Custom emoji

The eleventh patch adds Snowdrop-to-Snowdrop custom emoji delivery: when a message's text
contains a sender's own `:name:` custom emoji, the patched signal-cli uploads each one's image
as a normal encrypted attachment and carries `{name, attachment}` pairs on the message as an
_unknown_ DataMessage field. Official Signal clients (and unpatched signal-cli) silently ignore
unknown fields — they still show the plain `:name:` text and nothing else. Only a signal-cli with
this patch (receiving) decodes and exposes the delivered images. Works in 1:1 chats, groups, and
edits (an `EditMessage` wraps a `DataMessage` the same way).

This patch depends on `patches/signal-service-java`'s generic unknown-fields hook — see that
patch set's README for what it adds to the library and how `scripts/build-signal-cli.sh` builds
and wires it in. Everything _specific_ to custom emoji (the field number, the wire shape, the
JSON-RPC surface) lives entirely in this patch, in signal-cli's own source.

### Wire shape

Field 9000 on `DataMessage` (chosen well above Signal's own field numbering, which tops out in
the low two digits for top-level `DataMessage` fields): a `SnowdropExtension` submessage,
entirely private to this patch (not declared in any `.proto` file — encoded and decoded by hand
in `SnowdropCustomEmojiCodec`, using Wire's public low-level `ProtoReader`/`ProtoWriter`/
`ProtoAdapter` APIs the same way Wire's own generated code does):

```proto
// Field 9000 on DataMessage.
message SnowdropExtension {
  repeated SnowdropEmojiEntry emoji = 1;
}
message SnowdropEmojiEntry {
  string name = 1;
  bytes attachment = 2; // a serialized, standard Signal AttachmentPointer proto
}
```

The nested attachment is a real `AttachmentPointer` (the same proto type ordinary message
attachments use), built on send via `AttachmentPointerUtil.createAttachmentPointer` and read back
on receive via `AttachmentPointerUtil.createSignalAttachmentPointer` — both already-public
methods on signal-service-java (no patch needed for either direction of that conversion). This
means a received custom emoji attachment downloads and decrypts through signal-cli's completely
ordinary attachment path; it is not a bespoke shape.

### Sending

JSON-RPC `send` (and `sendEditMessage`'s underlying path) gains an optional `customEmoji`
parameter: a list of `{name, attachment}` objects, where `attachment` is the same kind of value
as a normal `attachments` entry (a file path or a `data:` URI). Snowdrop is expected to send only
the custom emoji whose `:name:` tokens actually appear in the message text, deduplicated — this
patch does not itself scan the text for tokens (that's Snowdrop's own job; see
`docs/SIGNAL_CLI.md`). Each entry's image is uploaded exactly like a normal attachment
(`AttachmentHelper.uploadAttachment`). Defensive caps: at most `SnowdropCustomEmojiCodec.
MAX_ENTRIES` (50) entries per message, and each uploaded attachment must be at or under 256 KiB
(matching Snowdrop's own client-side cap on custom emoji images) — a message that exceeds either
cap fails the whole send with a clear error rather than silently dropping entries.

### Receiving

`IncomingMessageHandler` decodes field 9000 from the raw, pre-`SignalServiceContent` `Content`/
`DataMessage` Wire proto that's already available there (`SignalServiceCipherResult#getContent()`
— nothing about signal-service-java needed to change for this direction; see that patch's
README). Malformed data — a field that doesn't parse as `SnowdropExtension`, an entry missing its
name or attachment, more than `MAX_ENTRIES` entries — is dropped (that one field, or that one
entry) without failing the whole message, and logged at debug level without message content.

The decoded entries are threaded through to `MessageEnvelope.Data.customEmoji`: a list of
`{name, attachment}`, where `attachment` is the exact same JSON shape (`JsonAttachment`) as an
ordinary message attachment, downloadable through the existing `getAttachment` RPC. Only the
emoji actually delivered with _that_ message appear there — never a guess from any local
collection. This is threaded through for both a plain `DataMessage` and an `EditMessage`'s wrapped
`DataMessage`; a `SyncMessage`'s self-sent echo (`sentMessage.dataMessage`, a different nested
position in the raw proto) is not covered by this patch.

Custom emoji attachments are downloaded eagerly to signal-cli's local cache on receipt, exactly
like ordinary message attachments, except that an entry whose pointer declares no size or more than
256 KiB (the same cap the send side enforces) is not downloaded, and a message makes us download at
most 4 MiB of declared emoji size in total (`SnowdropCustomEmojiCodec.downloadable`); the rest stay
in `customEmoji` but have nothing to fetch. Otherwise it works like ordinary attachments: `IncomingMessageHandler` converts each entry's `AttachmentPointer`
back to a `SignalServiceAttachmentPointer` (`AttachmentPointerUtil.createSignalAttachmentPointer`)
and calls the same `AttachmentHelper.downloadAttachment` ordinary attachments use, under the same
`ReceiveConfig.ignoreAttachments()` condition, for both a plain `DataMessage` and an `EditMessage`'s
wrapped `DataMessage`. An entry whose pointer doesn't parse is skipped (logged at debug level)
without affecting the rest of the message or the download of any other attachment, the same
tolerance `downloadAttachment` itself already has for an individual failed download. (An earlier
version of this patch left this step out entirely — the entries reached `MessageEnvelope.Data.
customEmoji` but their images were never fetched, so a later `getAttachment` for their id failed.
Fixed in patch level 11.)

`MessageEnvelope.Data.customEmoji` is also, as of patch level 11, actually serialized to the
JSON-RPC surface: `JsonDataMessage` (and anything built on it — `JsonEditMessage`, which wraps a
`JsonDataMessage`, and `JsonSyncDataMessage`, which unwraps one) gained a `customEmoji` field, a
list of `{name, attachment}` using the same `JsonAttachment` shape as ordinary attachments,
omitted when empty like its neighbouring list fields. (Patch level 10 decoded field 9000 into the
Java domain model but never wired it into the JSON actually emitted over JSON-RPC, so a receiving
Snowdrop never saw it at all — the bug this patch level fixes.)

### Capability detection

Nothing upstream advertises support for this. Snowdrop detects it from signal-cli's own version
string: a build with `snowdrop-history.N` where `N` is at least this patch's number (11) supports
`customEmoji`; anything else (upstream signal-cli, the demo backend, an older patched build)
doesn't, and Snowdrop falls back to sending/rendering plain text. Patch level 10 could _send_
custom emoji (that half worked) but not receive them, so Snowdrop's threshold
(`MIN_CUSTOM_EMOJI_PATCH_LEVEL`, src/core/backend/signal-cli/capabilities.ts) moved from 10 to 11
rather than staying put — a .10 peer would otherwise look capable while silently failing to
deliver received emoji.

### Verification

- Java unit tests: `SignalServiceDataMessageUnknownFieldsTest` (signal-service-java, the generic
  hook) and `SnowdropCustomEmojiCodecTest` (signal-cli, encode/decode round trips through real
  Wire proto encoding — including through a nested `EditMessage`, multiple entries preserving
  order, tolerance of malformed/oversized/missing-field input, and the download limits). `JsonDataMessageTest` now also
  asserts the serialized JSON itself carries `customEmoji` as `{name, attachment: {id, ...}}`, not
  just a codec round trip, and that it's omitted when empty.
- `scripts/build-signal-cli.sh --test` builds and smoke-tests the complete runtime with this
  patch and patches/signal-service-java's jar substituted in; see that command's own output for
  current pass/fail counts.
- Not verified: an actual Snowdrop-to-Snowdrop send/receive over Signal's servers (no test
  account available in this environment), and the real-phone check that official Signal shows
  only the `:name:` text — both are the user's to do.

First shipped as build `0.14.8-snowdrop-history.11`.

## 0012: recoverable attachments

signal-cli only ever held an attachment's `SignalServiceAttachmentPointer` — the CDN number, key,
digest and size needed to download it — for the few seconds `IncomingMessageHandler` took to
download it during receive. If that download failed (a network blip, one of the slow startup
periods noted below) or the file was lost afterwards, the pointer was gone: `getAttachment` could
only report "Could not find attachment with ID" forever, since nothing was left to retry from.
This affected every attachment kind `AttachmentHelper.downloadAttachment` handles — ordinary
`DataMessage` attachments, quote thumbnails, link-preview images, shared-contact avatars, stories,
and this fork's custom emoji — and `SyncMessage` sent transcripts the same way, since they reuse
the same `handleSignalServiceDataMessage` path. (Stickers are unaffected: they're fetched by pack
id/key, which `StickerStore` already keeps permanently, not by per-message attachment id.) A
second, independent bug compounded it: a failed download left a partially-written file behind
instead of nothing, so a later read could find a file that looks present but is actually
truncated — served without any error at all, rather than failing in a way `getAttachment` or a
retry could do anything about.

Fixes both:

- `AttachmentPointerStore` (new; keyed by the same id `getAttachment` takes — the downloaded
  file's name) persists each pointer as soon as it's seen, before
  `AttachmentHelper.downloadAttachment` attempts the download, not after. Its table
  (`snowdrop_attachment_pointer`) is created lazily with `CREATE TABLE IF NOT EXISTS` on first use,
  the same way `HistoryStore`'s `snowdrop_history_*` tables are — not through `AccountDatabase`'s
  own versioned schema. Bumping `AccountDatabase.DATABASE_VERSION` would mark the file as needing
  at least this signal-cli version to open at all (breaking the documented rollback to plain
  upstream signal-cli) and would collide with whatever version number upstream's own next schema
  change picks.
- `AttachmentHelper.retrieveAttachment(id)` re-downloads on demand from the persisted pointer when
  the file isn't found, verifying the digest and size exactly as the original download does
  (`retrieveAttachment(SignalServiceAttachment, OutputStream)`, unchanged). A CDN 404/410 (the
  attachment expired) becomes a distinct `AttachmentNotAvailableException`, surfaced as a
  `UserErrorException` ("Attachment is no longer available on the server…") rather than an
  internal error; any other failure becomes an `IOErrorException` rather than
  `UnexpectedErrorException`, since it isn't a bug. Only when no pointer was ever persisted at all
  (an attachment received before this patch, or with attachments disabled) does the original
  "Could not find attachment with ID" error remain.
- `AttachmentStore.storeAttachment` now deletes the destination file if the download throws,
  instead of leaving whatever was already written — so a failed attempt (the first one, or a
  retry) always leaves "missing", never "corrupt", behind.

Verification: `scripts/build-signal-cli.sh --test` (Java unit tests:
`AttachmentPointerStoreTest`, round-tripping a pointer through the real account database file and
through Wire proto encoding). The Snowdrop-side failure classification, retry UX and logging this
motivated are covered by `npx vitest` in the main repo, not here.

First shipped as build `0.14.8-snowdrop-history.12`.

## 0013: linked-device account record integrity

Right after linking, Signal's own apps could show "There's a problem with your username" on the
phone. The cause was in `StorageSyncModels.localToRemoteRecord` (used for every AccountRecord
signal-cli builds for upload): it always set `username`/`usernameLink` from local state —
`self.getAddress().username()` (the self recipient row's address) and `account.getUsernameLink()`
— regardless of device role. On a linked device that address field is never refreshed:
`SignalAccount.setUsername`/`setUsernameLink` (which `AccountRecordProcessor.updateLocal` calls
once it learns the real values from a remote AccountRecord) update `SignalAccount`'s own fields,
not the self recipient's stored `RecipientAddress`, which is only ever set by
`resolveSelfRecipientTrusted` at account creation/registration time — never by `setUsername`. So
`self.getAddress().username()` stays empty for the lifetime of a linked device. Any subsequent
account-record write (routine: several `SyncStorageJob` enqueues fire right after linking, e.g.
`AccountHelper.updateSelfIdentifiers`) rebuilt the record through `localToRemoteRecord`, which
overwrote the correct, already-learned username with `""` and rebuilt `usernameLink` from scratch,
re-uploading a corrupted AccountRecord over the real one.

`AccountRecordProcessor.merge` itself was already correct — it builds the merged proto from
`remote.newBuilder()`, which Wire's generated code carries `remote.unknownFields()` into via
`addUnknownFields`, and it hardcodes `.username(remote.username)` /
`.usernameLink(remote.usernameLink)` regardless of local state. The bug was specifically in the
record-building path used to construct what gets re-uploaded, not in the merge/diff logic. The
same pattern already existed for `ContactRecord`'s `systemGivenName`/`systemFamilyName`
(`account.isPrimaryDevice() ? local.x : remote.x` in `ContactRecordProcessor.merge`), confirming
this codebase's own convention for fields only a primary device may originate locally.

Fix: `StorageSyncModels.localToRemoteRecord` takes a new `isPrimaryDevice` parameter (passed by
all three callers — `AccountRecordProcessor`'s constructor, and both of
`StorageHelper`'s `localToRemoteRecord` call sites for ACCOUNT records). A linked device
(`shouldSetUsernameFieldsLocally(false)`) never touches `username`/`usernameLink` on the builder at
all, leaving them at whatever `self.getStorageRecord()` already decoded (the last successfully
merged, remote-sourced record) — never local, never empty. A primary device keeps the previous
behavior unchanged.

While adding tests for "a fresh link produces no write," a second, unrelated needless-write bug
surfaced in the same `merge`: `safeSetPayments` (signal-service-java) unconditionally builds a
`Payments.Builder().build()` object, turning an absent `payments` field present-but-empty even
when neither remote nor local ever had one — forcing a spurious re-upload on every sync.
`AccountRecordProcessor`'s merge now only calls `safeSetPayments` when there's actually data to
set (from either side), leaving `payments` as remote's own absence otherwise. This is a
signal-cli-side guard around the existing signal-service-java helper; the helper itself wasn't
changed.

`AccountRecordProcessor.merge`'s record-building logic is now also exposed as a package-visible,
pure `buildMergedRecord(AccountRecord remote, AccountRecord local)` (plus `doProtosMatch`), so it's
directly unit-testable without a database: `StorageRecordProcessorTest` builds a remote
`AccountRecord` carrying a real username, usernameLink and a hand-crafted unknown field (an
out-of-schema varint field, encoded with Wire's `ProtoAdapter.UINT64.encodeWithTag`), merges it
against a "local" record simulating the stale/empty state a linked device could have, and asserts
the merged proto is byte-identical to remote — proving both that unknown fields and
username/usernameLink survive untouched, and that `doProtosMatch` would find no write needed on a
fresh link. A second test confirms local may still legitimately contribute a field remote left
unset (e.g. `givenName`) without username/usernameLink or unknown fields being affected.

No signal-service-java change was needed or made; this is a signal-cli-only fix.

First shipped as build `0.14.8-snowdrop-history.13`.

## 0014: attachment backfill

0012 lets a failed download retry from its own persisted pointer, but that pointer only ever
existed if signal-cli itself received the attachment in the first place. Two cases have nothing
to retry from at all: a file the old vault-sync bug deleted from disk before 0012 started
persisting pointers (`missing-on-disk`), and a transit CDN object that has since expired
(`expired`) — including a history attachment's (0006) archived transit pointer, which 0006 never
persists anywhere past the single download attempt. Signal has a protocol for exactly this: a
linked device asks its primary to re-upload a message's attachments.

`requestAttachmentBackfill` sends `SyncMessage.attachmentBackfillRequest` (already supported by
the patched signal-service-java's `SignalServiceSyncMessage.forAttachmentBackfillRequest`/
`getAttachmentBackfillResponse` — no signal-service-java patch needed) to our own linked devices:

```
requestAttachmentBackfill { recipient | groupId, targetAuthor, targetTimestamp, attachmentIds }
```

`recipient`/`groupId` (mutually exclusive) is the conversation the message belongs to;
`targetAuthor` its sender; `targetTimestamp` its `sentTimestamp`; `attachmentIds` the message's
attachment ids in order, exactly as Snowdrop already has them (including 0006's `history:…` ids).
These become the wire protocol's `AddressableMessage` (author + sentTimestamp) and
`ConversationIdentifier` (thread ACI/e164 or group id). A pending request is persisted in a
lazily created `snowdrop_attachment_backfill` table (`CREATE TABLE IF NOT EXISTS`, like 0012's
`snowdrop_attachment_pointer` — never a `DATABASE_VERSION` bump), keyed by (author,
sentTimestamp) with a created-at time. A request is recorded atomically before it is sent (so two
concurrent calls cannot both send), and removed again if the send fails: `requestAttachmentBackfill`
then fails with an error and nothing stays pending, so the user can ask again. A request nobody
answered within 3 minutes (a little longer than Snowdrop's 2 minute wait) counts as abandoned: it no
longer blocks a new one, so a Retry after the UI gave up really sends again, and it is pruned. A repeated
request for a message that is still pending is coalesced — the phone isn't asked twice.

When a `SyncMessage.attachmentBackfillResponse` comes back, only one from device id
`DEFAULT_DEVICE_ID` (our primary) is trusted; a sync message's fanout can reach our other linked
devices too, but only the primary can actually answer, so a response from anywhere else is
ignored. The response's attachments list is matched positionally against the pending request's
`attachmentIds`: each resolved `AttachmentPointer` is stored in `AttachmentPointerStore` — 0012's
store — under that original id, deleting any stale partial file first, so the existing
`getAttachment` → on-demand re-download path just works unmodified for ordinary attachments.
History attachment ids have no such existing fallback (0006 never persists a pointer for them at
all), so `AttachmentHelper.retrieveBackfilledHistoryAttachment` and `ManagerImpl.retrieveAttachment`
gained one: a `history:…` id whose archived transit download fails now falls back to a backfilled
pointer, when one was actually stored, before giving up with the original error.

Each item in the response is `PENDING` (no pointer yet, another response will follow),
`TERMINAL_ERROR` (that one attachment specifically is gone for good), or carries a pointer. Any
item count mismatch against the request, or a `MESSAGE_NOT_FOUND` error, fails the whole request.
Resolving emits a JSON-RPC notification, following how 0010's `receiveCaughtUp` is emitted
(one listener per manager, subscribed wherever `receive`/`receiveCaughtUp` already are):

```
{"jsonrpc":"2.0","method":"attachmentBackfill","params":{"targetAuthor":"…","targetTimestamp":…,"status":"pending|ready|failed","attachmentIds":["…"]}}
```

`pending` while at least one item in a response is still `PENDING` (the request stays open for a
later response); `ready` once every item has resolved, one way or another (an individual
`TERMINAL_ERROR` item just has no pointer to show for it); `failed` on `MESSAGE_NOT_FOUND` or a
count mismatch. No attachment key, digest or message content is ever logged.

Verification: `scripts/build-signal-cli.sh --test` (Java unit tests —
`AttachmentBackfillStoreTest`: pending-request round trip, removal, per-(author, timestamp)
isolation, reopened-database survival, age-based pruning, an atomic claim and stale rows;
`AttachmentBackfillHelperTest`: a new request is sent and tracked pending, a repeated one is
coalesced, a failed send leaves nothing pending and a retry sends again, a stale row does not block, a response maps pointers back
onto attachment ids by index, a `PENDING` response is followed by a `READY` one, a
`TERMINAL_ERROR` item resolves without a pointer for just that one, `MESSAGE_NOT_FOUND` and a
mismatched count both fail, and a response from a non-primary device id is ignored outright).
The Snowdrop-side auto-request/retry UX this motivated is covered by `npx vitest` in the main
repo, not here. Not verified here: an actual phone answering a real `attachmentBackfillRequest`
over Signal's servers — that's the user's to do.

First shipped as build `0.14.8-snowdrop-history.14`.

## 0015: JVM options and footprint

The first part of this patch adds
`--sun-misc-unsafe-memory-access=allow` to `build.gradle.kts`'s
`applicationDefaultJvmArgs`, alongside the existing
`--enable-native-access=ALL-UNNAMED`. Without it, every launch logs four
lines of JEP 498 terminal-deprecation noise once protobuf-java's
`UnsafeUtil$MemoryAccessor` touches `sun.misc.Unsafe::arrayBaseOffset` (seen
in Snowdrop's own startup log via `protobuf-java-4.31.1.jar`): "A terminally
deprecated method in sun.misc.Unsafe has been called" and three follow-up
lines. JDK 25 still defaults memory-access `Unsafe` to allowed, so this flag
changes nothing about behaviour — it only opts out of the warning ahead of a
future release where the default flips to `warn` or `deny`. Purely cosmetic.

An AOT cache (JDK 25 `-XX:AOTCache=`, JEP 483/514/515) was investigated for
faster `jsonRpc` startup but is **not** shipped. Measured against the built
dist (cold, throwaway config dir, no account, `version` over JSON-RPC,
interleaved A/B so both arms see the same host noise): a trained cache
(`-XX:AOTCacheOutput=` against the jlinked runtime, a few typical requests)
shaved roughly 11–12% off median time-to-first-`version`-reply across two
10+ run batches — under the ~15% bar worth the trade-off — while adding
~32 MB (~16%) to the 194 MB dist and a build-time training step to maintain.
Most of signal-cli's own startup cost sits in BouncyCastle's crypto
provider, which `-XX:AOTCache=` can't help at all: BC's jar is signed, and
the JVM silently skips every class from a signed jar when assembling the
cache (logged as `Skipping ... Signed JAR` during the training run). If a
future JDK lifts that restriction, or BC startup cost drops for other
reasons, this is worth re-measuring. For the record, had this shipped, the
launcher would point `-XX:AOTCache=` at a path computed relative to
`root_dir` in `bin/signal-cli` (so it keeps working wherever the dist is
installed) and the JVM's own `-XX:AOTMode=auto` default (implied when only
`-XX:AOTCache=` is set, no explicit `-XX:AOTMode=`) already warns-and-
continues rather than failing to start when the cache is missing or
mismatched — confirmed by pointing `-XX:AOTCache=` at a nonexistent file and
checking the process still started and exited 0. That path does still log
an `[error][aot]` line to stderr on every launch, though, so shipping it
would also need `-Xlog:aot=off` to keep it from spamming the log.

The second part adds `-XX:MaxRAMPercentage=50`,
`-XX:+UseCompactObjectHeaders`, `-XX:G1PeriodicGCInterval=120000`,
`-XX:MinHeapFreeRatio=10` and `-XX:MaxHeapFreeRatio=30` to the same
`applicationDefaultJvmArgs`.
Measured against the built dist in `jsonRpc`
mode (cold, throwaway config dir, no account, median of 5 interleaved runs,
idle PSS via `/proc/<pid>/smaps_rollup`): idle PSS didn't move measurably
with a heap cap either way (G1 already shrinks committed regions back down
to the live set regardless of the cap), so the cap is a safety bound, not an
idle-PSS win. It follows the machine's RAM rather than a fixed size: an
earlier fixed `-Xmx1024m` was too low, because `getAttachment`
(`GetAttachmentCommand`) reads the whole attachment into a `byte[]`,
Base64-encodes it to a `String` and Jackson writes that again. One 150 MB
attachment (`ServiceConfig.MAX_ATTACHMENT_SIZE`) holds roughly 750 MB live,
two at once ran out of heap, and an `OutOfMemoryError` kills the whole
daemon. `AttachmentHelper.retrieveBackfilledHistoryAttachment` (a history
attachment whose archived pointer expired) also buffers a whole attachment
on-heap.
`-XX:+UseCompactObjectHeaders` shaved a noisy ~2-3% off idle PSS with no
measured CPU cost (checked against a 150 MB AES-GCM+SHA-256 throughput
benchmark run under the jlinked runtime) — kept regardless, since it's
free. Tried and dropped: `-XX:+UseSerialGC` measured _worse_ (idle PSS rose
from ~137 MB to ~228 MB on this box — G1 reclaims unused regions more
aggressively than Serial's simpler heap at this scale).
`-XX:TieredStopAtLevel=1` shaved ~21% off idle PSS but made the same 150 MB
AES-GCM+SHA-256 benchmark ~9x slower (C2's crypto-loop optimizations never
kick in), which fails the "100 MB+ attachments must still work" bar.
`-Xss512k` and `-XX:+UseStringDeduplication` showed no measurable change in
this harness (too few threads/strings without a real account to show it
either way) and were dropped rather than shipped on faith.

A later pass (same patch, amended rather than a new one — nothing about this
is committed to any user's installed copy yet) addressed a gap the above
measurement couldn't see: all of it was taken at idle, after the process had
settled, never _after a burst_. The real session this pass was planned
against showed the daemon's heap had only 33 MB live in a 100 MB committed
heap — plausible after a burst of JSON-RPC traffic that G1 never got a
reason to shrink back down from, since nothing forces a GC once allocation
stops. `-XX:G1PeriodicGCInterval=120000` runs a concurrent cycle on a
2-minute idle timer so that comes back down on its own. Verified directly
against the jlinked runtime with a throwaway config and no account (`jcmd
<pid> GC.heap_info`, `-Xlog:gc`): a burst of 6,000 JSON-RPC calls (padded
params, to force real allocation) pushed committed heap from a 50 MB
baseline to 278 MB; with the interval temporarily set to 8 s for faster
iteration, two periodic cycles later (~20 s) it was back to 55 MB, and PSS
back near its original 143 MB. Every periodic pause logged 1-2 ms, and the
idle CPU cost of running them was about 4 centiseconds of CPU time over
that 20 s window (`/proc/<pid>/stat`) — negligible. 120 s sits inside the
60-300 s range that trades promptness against how often an otherwise-idle
process wakes up; nothing here is latency-sensitive enough to want it
sooner. `-XX:MinHeapFreeRatio=10`/`-XX:MaxHeapFreeRatio=30` (below G1's own
default free-ratio targets) make each of those collections return more of
the freed heap to the OS instead of holding it as slack: measured together
with the interval above, the same kind of burst-then-idle cycle came back
to 25 MB committed instead of 55 MB, at a similarly negligible idle CPU
cost (~8 centiseconds over 20 s). Both flags only change G1's heap-resize
policy at GC pause boundaries, not its collection algorithm or the JIT
tiers the AES-GCM throughput benchmark above depends on, and every pause
logged during and after the burst stayed in the 1-13 ms range, well short
of the kind of throughput cost `-XX:TieredStopAtLevel=1` had.
Nothing Snowdrop's capability checks see changes with any of this: flags
only, same jar, same behaviour. What a throwaway, no-account dist can't
show: real account traffic's actual allocation pattern and burst timing,
and whether 120 s is the right trade-off for how the user's own session
idles — only their own running app, left alone afterward, can confirm the
committed-heap number this was aimed at actually comes back down.

## 0016: history sticker pack

`getSticker --pack-id --sticker-id` already retrieves a sticker from signal-cli's own
sticker store, downloading the pack on demand — but only when that store already knows the
pack's decryption key, which happens today only when this device received the sticker live
(`IncomingMessageHandler` registers the key and enqueues `RetrieveStickerPackJob` on receipt). A
sticker that arrived solely through an imported phone-history archive (0004) has no such live
receipt, so `getSticker` fails for it even though the archive itself carries the pack's key —
`Backups.Sticker.packKey`, alongside `data`, the backup's own copy of the image 0009 already
exposes as a `history:…:sticker:0` attachment.

Registering that key the way `addStickerPack` does would also install the pack and sync that
install to the user's phone — wrong for a key that's only ever needed locally to decode an old
message. `IncomingMessageHandler`'s own path (`new StickerPack(packId, packKey)` with
`installed` defaulting to `false`, then `StickerStore.addStickerPack`) doesn't: with no
`deletedTimestamp` and `installed` false, `addStickerPack` assigns no `storageId`, so the row
is invisible to `StorageSyncHelper`'s set of synced ids — exactly the "known locally, never
on the phone" state a history sticker needs.

New RPC `registerHistoryStickerPack { id }` takes the same opaque `history:…:sticker:0` id
`getAttachment` already accepts for that message's backup image, resolves it server-side
(`HistoryStore.stickerPack`, a sibling of `attachment()` reading the same backup frame) to the
sticker's `packId`/`packKey`, and — if the pack isn't already known — registers it via that
same `IncomingMessageHandler` path. The key itself is never a request parameter and never a
response field; it only ever moves from the backup frame straight into `StickerStore`, inside
this one process. Snowdrop's own TS layer only ever handles `packId` (hex) and `stickerId`
(plain identifiers, not secrets) — see Snowdrop's `StickerContent` domain type, which has no
key field at all.

Usage: on a `getSticker` failure for a sticker whose domain record carries a history backup
attachment, call `registerHistoryStickerPack` with that attachment's own id, then retry
`getSticker` once. If the id doesn't resolve to a sticker message (wrong kind, expired
snapshot, or the archive never had one), it fails the same way `getAttachment` does for a bad
history id, and the caller falls back to the backup image, then to showing the sticker's emoji.

Verification: `scripts/build-signal-cli.sh --test` (Java unit test —
`HistoryAttachmentTest.resolvesAStickersPackKeyWithoutExposingItThroughTheAttachmentPath`: the
pack id/key round-trip through `stickerPack()`, a non-sticker id and a message with no sticker
are both refused). First shipped as build `0.14.8-snowdrop-history.15`.

### Re-read a sticker after downloading its pack

Upstream's `ManagerImpl.retrieveSticker` reads the sticker from the pack store; when that
returns nothing but the sticker store already knows the pack and its key, it calls
`retrieveStickerPack` to download the pack — and then throws `FileNotFoundException` anyway,
because it never re-reads the sticker it just downloaded. Only a _second_ call succeeds. For a
pack this device learned of but never fetched (a live sticker whose pack job hasn't run, or a
history sticker just registered by the pack registration above) the first `getSticker` therefore always failed.

This part re-reads the sticker once after a successful pack download. A failed download still logs
the same warning and ends in `FileNotFoundException`. No new RPC, no storage change (no
`DATABASE_VERSION` bump), nothing is added to the phone's sticker list and nothing syncs.

Snowdrop needs no capability gate for it: against `history.15` (before the re-read) the first `getSticker`
after the pack download still fails, so Snowdrop retries `getSticker` once more after
registration, which is exactly the call that works there (see `resolveStickerUrl`); against
`history.16` that retry just succeeds one call earlier. Nothing changes for the user's phone.

Verification: `scripts/build-signal-cli.sh --test` (the patch only touches a code path that
needs a live server, so there is no new Java unit test; the build and existing suite must still
pass). First shipped as build `0.14.8-snowdrop-history.16`.

## 0017: install a known sticker pack

Snowdrop's sticker pack dialog ("Install" on a sticker someone sent) needs signal-cli's own
`installStickerPack`, but upstream's `addStickerPack --uri` wants the pack's share URL, which
embeds the pack **key** — and Snowdrop deliberately never holds keys (`StickerContent` and its
`listStickerPacks` decoder drop them). The key is already in signal-cli's sticker store for any
pack this account has learned of: from a live-received sticker (`IncomingMessageHandler`
registers it) or from a history archive (0016).

New RPC `installKnownStickerPack { packId }` (hex) looks the pack up in that store by id alone,
fails with an I/O error if the account has never learned of it, returns at once for a pack that
is already installed, and otherwise does exactly what `ManagerImpl.installStickerPack` does with
a URL: download the pack (`StickerHelper.retrieveStickerPack`), mark it installed
(`addOrUpdateStickerPack`, which gives it a storage id), and send the install sync message to
the primary device (`sendStickerOperationsMessage`). So — unlike 0016, which never touch
the phone's list — this one **does** sync to the phone, like Signal's own "Install"; it is only
ever sent for an explicit click in Snowdrop's dialog. The key never leaves the process: it is
neither a request parameter nor a response field (the reply is `{ "installed": true }`).
Uninstalling is not covered. A history sticker's pack must be registered first
(`registerHistoryStickerPack`, 0016); Snowdrop does that before calling this.

No storage change and no `DATABASE_VERSION` bump (the `sticker` table is untouched).

Snowdrop gates the dialog's Install button on `snowdrop-history.N` with N at least 17
(`supportsStickerPackInstall`, `src/core/backend/signal-cli/capabilities.ts`); on an older
build the dialog still shows the pack but Install is disabled with an explanation.

Verification: `scripts/build-signal-cli.sh --test` (Java unit test —
`StickerHelperTest`: an unknown pack is refused, a registered-but-uninstalled pack is found with
its key and no storage id, and installing it is what gives it one, i.e. what makes it sync).
First shipped as build `0.14.8-snowdrop-history.17`.

## 0018: privacy configuration

Signal's read receipts, typing indicators, link previews and unidentified-delivery indicators are
account settings the phone owns. signal-cli already stores them as a linked device: a configuration
sync message (`IncomingMessageHandler`) and the storage-service account record
(`AccountRecordProcessor.updateLocal`) both write `ConfigurationStore`. Nothing read them back over
JSON-RPC (upstream has `updateConfiguration` but no getter), so Snowdrop kept using its own settings
and sent receipts the user had turned off on the phone.

- `getConfiguration` returns `{ readReceipts, typingIndicators, linkPreviews,
unidentifiedDeliveryIndicators }`, each `true`, `false` or `null` while the phone hasn't said.
  Nothing else in the configuration (number sharing, username link colour, ...) is returned.
- `receiveConfigurationChanged` is a notification with the same shape and subscription handling as
  `receiveCaughtUp` (`{"account":"…"}`, no values). It is sent when one of the four values actually
  changed: after a configuration sync message, after a storage-service sync, and after a local
  `updateConfiguration`. Callers re-read with `getConfiguration`. `ConfigurationStore` takes a
  snapshot before a write and notifies after it is committed (`notifyIfChanged`), so a re-read never
  sees a half-applied storage sync; re-writing the same values notifies nobody.
- `updateConfiguration` is upstream's command, unchanged: it stores the values, sends a
  configuration sync message and pushes the account record through the storage service, which is
  how Signal Desktop propagates its own changes. Snowdrop's native shell allow-lists the method with
  only the four boolean keys (`src-tauri/src/rpc_guard.rs`).

No storage change and no `DATABASE_VERSION` bump. Snowdrop gates all of it on `snowdrop-history.N`
with N at least 18 (`supportsPhonePrivacy`, `src/core/backend/signal-cli/capabilities.ts`); an
older build leaves Snowdrop on its own local settings.

Verification: `scripts/build-signal-cli.sh --test` (Java tests —
`ConfigurationStoreTest`: values start unknown and round-trip, a write that changed something
notifies once, an identical write notifies nobody; `GetConfigurationCommandTest`: known values,
explicit nulls for unknown ones, nothing else exposed; `ReceiveConfigurationChangedNotificationTest`:
the notification, bare params on the default subscription, listener cleanup). Not verified against a
real phone: that a change made from this linked device reaches the phone's storage service record.
First shipped as build `0.14.8-snowdrop-history.18`.

## 0019: sync-only read receipts

`sendReceipt type=read` does two things: it sends a receipt to the message's sender (skipped when
the account's read-receipts setting is off) and it always sends a read sync message to the
account's own other devices, which is what marks the messages read on the phone. Snowdrop only
called it when the chat was accepted and receipts were allowed, so reading a message request, or
reading with receipts off, never reached the phone.

- `sendReceipt` takes a new boolean `syncOnly` (`--sync-only` on the command line). With it signal-cli
  sends only the own-device sync (`Manager.syncReceiptToOwnDevices`, same `SyncHelper` path as
  before) and no receipt to the sender, whatever the setting. It also takes `type viewed`. The reply
  is `{"timestamp":0,"results":[]}` and it never fails for want of a result. Without `syncOnly` the
  command is unchanged. The DBus `Manager` implementation does not support it.
- No storage change and no `DATABASE_VERSION` bump. The method name is unchanged, so the native
  shell's allow-list needs nothing new (`syncOnly` is not a file reference, so `rpc_guard.rs` passes it).

Snowdrop gates it on `snowdrop-history.N` with N at least 19 (`supportsReadSync`,
`src/core/backend/signal-cli/capabilities.ts`). On an older build a read where no receipt is
allowed sends nothing, as before, and the backend never sends `syncOnly` to it (an old signal-cli
would take it for a plain receipt).

Verification: `scripts/build-signal-cli.sh --test` (Java test `SendReceiptCommandTest`: `syncOnly`
syncs and sends no receipt, keeps the viewed type, rejects an unknown type; without it the normal
receipt is sent). Not verified against a real phone: that the sync marks the messages read there.
First shipped as build `0.14.8-snowdrop-history.19`.

### Receipt sync outcome

`sendReceipt` used to ignore how the own-device read sync went: `SyncHelper.sendSyncReceiptMessage`
returned nothing and `SendHelper.sendSyncMessage` turns a send exception into a result nobody read,
so a sync that never reached the phone looked exactly like one that did.

- `sendSyncReceiptMessage` returns the `SendMessageResult` (null only for a receipt that is neither
  read nor viewed). `Manager.sendReadReceipt` / `sendViewedReceipt` return a `ReceiptResults`
  (the unchanged `SendMessageResults` plus a `ReceiptSyncOutcome`); `syncReceiptToOwnDevices` returns
  the `ReceiptSyncOutcome` instead of a boolean.
- The JSON-RPC reply of `sendReceipt` gains `"sync"`: `success`, `network`, `identity`,
  `unregistered`, `rate-limit`, `proof-required`, `skipped-no-aci`, `skipped-single-device` or
  `error`. It is present on both the normal path and `syncOnly`; `timestamp` and `results` keep
  their shape. `skipped-*` means no sync message was attempted (no known ACI for the sender; no
  linked device). `unregistered` also covers a sender that could not be resolved.
- Whenever the sync is not a `success`, signal-cli logs one WARN with that type and nothing else
  (no ids, numbers or timestamps).
- No storage change and no `DATABASE_VERSION` bump. The method name and params are unchanged, so
  the native shell's allow-list needs nothing new. An older build simply has no `sync` field.

Verification: `scripts/build-signal-cli.sh --test` (`ReceiptSyncOutcomeTest`: every result type maps
to its value, only `success` is a success; `SendReceiptCommandTest`: `sync` on the syncOnly and
normal replies for every outcome, `results` unchanged). Not verified against a real phone.
First shipped as build `0.14.8-snowdrop-history.20`.

## 0020: receive catching up notification

`receiveCaughtUp` (0010) says the server's queue is empty, but nothing said it had started to fill.
signal-cli reconnects to Signal's server by itself (after a sleep, a network change), and
everything queued meanwhile then arrives as ordinary `receive` notifications. A client that only
treats its own start as a catch-up cannot tell those from new messages.

- New JSON-RPC notification `receiveCatchingUp`, same shape and subscription handling as
  `receiveCaughtUp` (`{"account": ...}` on the default subscription, wrapped with `subscription` /
  `result` on an explicit `subscribeReceive`). No other fields.
- It first fired from `ReceiveHelper.onWebSocketStateChange` when the authenticated websocket
  reached `CONNECTED`. That runs on a scheduler thread, so it could arrive after messages the receive
  thread had already read; the ordered signal below replaces it.
- `Manager` gains `addCatchingUpWithOldMessagesListener` / `remove...`; DBus does not support it.
- No storage change and no `DATABASE_VERSION` bump. A notification needs no new method, so the
  native shell's allow-list (`rpc_guard.rs`) is unchanged; its notification forwarding gains the
  new name.

Snowdrop gates it on `snowdrop-history.N` with N at least 21 (`supportsCatchingUpSignal`,
`src/core/backend/signal-cli/capabilities.ts`). Older builds behave as before.

Verification: `scripts/build-signal-cli.sh --test` (`ReceiveCatchingUpNotificationTest`: shape on
both subscription kinds, once per connect, cleanup, not subscribed without `subscribeReceive`;
`ReceiveHelperCatchingUpTest`, rewritten for the ordered signal). Not verified against a real wake from sleep. First shipped as build `0.14.8-snowdrop-history.21`.

### Catching up is ordered before the connection's first envelope

The first version of `receiveCatchingUp` came from a state observer on a scheduler thread. After a wake the receive
loop can read and forward the first queued envelopes before it runs, so those messages arrived as
ordinary live ones and notified. Looking for a synchronous observer to fix that, the state stream
turned out not to be usable at all: `SignalWebSocket.getOrCreateWebSocketLocked` republishes each
connection's state through `subscribeOn(Schedulers.io()).observeOn(Schedulers.io())`, so even a
subscriber with no hop of its own sees `CONNECTED` after the read side already could. (The connection
itself is fine: `LibSignalChatConnection.handleConnectionSuccess` holds its lock across `start()` and
the state change, and `readRequest` needs that lock. It is the republishing that is late.)

- `ReceiveHelper.readMessageBatch` wraps `AuthenticatedWebSocket.readMessageBatch`. When the read
  returns, it compares `getConnectionName()` (the identity of the connection the websocket holds now)
  with the last one it announced, and fires the catching-up listener on a change, before returning.
  The connection is replaced inside `getWebSocket()`, which the read goes through, so after a read has
  returned the name is that of the connection the read was served from, or of a newer one (which only
  announces early). The receive loop handles the batch's envelopes, and the queue-empty indicator that
  becomes `receiveCaughtUp`, after that call returns, on the same thread. So for each connection
  `receiveCatchingUp` is sent strictly before its first envelope and before its `receiveCaughtUp`, and
  it is sent once. The name is reset at the start of each receive session, so the first connection counts.
- `onWebSocketStateChange` no longer fires it (it would have announced a second time, out of order).
- The catching-up and caught-up listeners are called through a guard that logs and drops an exception
  (a JSON-RPC listener can throw; an `AssertionError` still propagates, as the loop expects), so one cannot end the receive iteration and leave the envelope that
  was just read waiting until the next receive session.
- The JSON-RPC shape, `Manager` API and DBus behaviour are unchanged from that first version. No storage change and
  no `DATABASE_VERSION` bump.

Snowdrop gates the stricter behaviour on `snowdrop-history.N` with N at least 23
(`supportsOrderedCatchingUp`). With it, a notification hold started by `catchingUp` ends only on
`caughtUp` or its 2 minute ceiling. Builds 21 and 22 behave as before (quiet period as well).

Verification: `scripts/build-signal-cli.sh --test` (`ReceiveHelperCatchingUpTest`, a real
`AuthenticatedWebSocket` over fake connections read the way the receive loop does: catching-up before
the first envelope, before caught-up on an empty queue, once per connection and again on a reconnect
whose backlog is already queued, nothing for a read that times out, and a throwing listener that
still lets the envelope through). Not verified against a real wake
from sleep. First shipped as build `0.14.8-snowdrop-history.23`.

## 0021: a profile edit also updates the storage-service account record

`updateProfile` stored the new values and uploaded the profile, but never touched the storage-service
account record, which also holds the given name, family name and avatar path. Signal Desktop
marks that record changed on a profile edit (`captureChange('writeProfile')`), so it is uploaded with
the new values. signal-cli did not, and the next storage merge
(`AccountRecordProcessor.buildMergedRecord` prefers a non-empty remote name; `avatarUrlPath` the same)
wrote the old name or photo back over the edit.

- `ProfileHelper.setProfile` (the `updateProfile` path) compares the stored self profile before and
  after. If the given name, family name or avatar path changed, it sets a persisted flag
  (`snowdrop-profile-storage-pending`, in the existing `key_value` table), rotates the self storage
  id (as `rotateProfileKey` does) and enqueues a `SyncStorageJob`. An about-only change, or saving
  identical values, does none of it (the about text is not in the account record).
- While the flag is set, `AccountRecordProcessor` takes those three fields from local, even when
  empty (a removed avatar or family name stays removed). Every other field is merged exactly as
  before, so a newer phone change to settings, pins, the expire timer, usernames and the rest still
  applies and is carried into the record that gets uploaded.
- `StorageHelper` clears the flag once a successful write, an empty write, or a force push leaves the
  current self account id in the manifest on the service. A newer edit rotates that id, so its flag
  survives an older push. After that the ordinary rule applies again and a later phone edit wins.
- The record that is uploaded is built the same way as for any account-record push
  (`StorageSyncModels.localToRemoteRecord`): the last stored record, plus the privacy settings from
  the configuration store, plus the profile key, name and avatar. A linked device keeps the stored
  username and link.
- No storage change and no `DATABASE_VERSION` bump (the flag is a `key_value` row). The method name
  and params are unchanged, so Snowdrop needs no capability gate and the native shell's allow-list is
  unchanged. An older build keeps the old behaviour.

Verification: `scripts/build-signal-cli.sh --test` (`AccountRecordProfileWinsTest`: a stale remote
name or avatar does not revert a pending edit, the result is the remote record with exactly those
three fields replaced, newer remote changes to other fields still apply, a later phone edit wins
once the flag is cleared, a removed avatar or family name stays removed, the merged record or id
that gets uploaded; `ProfileStorageUploadTest`, against the real recipient store: the uploaded record
carries the new name and avatar and every other field as stored, an avatar removal uploads an empty
path, an about-only change leaves the record unchanged, the rotated id makes the sync see a local-only
record; `ProfileStoragePendingTest`: which edits count, when the flag clears). Not verified against a
real phone. First shipped as build `0.14.8-snowdrop-history.22`.

## 0022: a clean exit when stdin closes

Snowdrop stops signal-cli by closing its stdin. The command then returns, the managers are closed
(`ManagerImpl.close`: the receive thread stops, the websockets disconnect, the account database
closes) and `Main` calls `System.exit(0)`. A JVM exits 0. The GraalVM native build aborted with
`Fatal error: java.lang.InterruptedException` and exit status 134 (SIGABRT), with or without a pending
`startLink`.

The cause is the interrupt flag of the thread that calls `System.exit`. `Shutdown`'s JVM shutdown hook
ran `triggerShutdown()` whenever the shutdown future was not yet complete, which is always the case
when the exit was not a signal. That ran the listeners `JsonRpcDispatcherCommand` registers
(`thread::interrupt`), interrupting `main` while it was inside `System.exit` (a closed manager's
`addClosedListener(currentThread::interrupt)` does the same in single-account mode). A JVM ignores the
flag there. A native image's `System.exit` joins its signal-dispatcher thread
(`PosixSignalHandlerSupport.stopDispatcherThread`), and `Thread.join` on an interrupted thread throws,
which the runtime treats as fatal. By then the command had finished and the managers were closed, so the
crash lost no data; it only turned a normal stop into an abort (and a crash dump in Snowdrop's log).

- `Shutdown.onJvmShutdown` (the hook's body) no longer triggers the shutdown once `Main` has reported
  the command finished: there is nothing left to stop, and the listeners only interrupt.
- `Shutdown.shutdownComplete`, which `Main` calls right before `System.exit`, clears the thread's
  interrupt flag, for the single-account case where the manager's own close listener sets it.
- What is saved on stdin EOF is unchanged and still happens before the exit: the subscriptions are
  removed, then the managers are closed (and the databases with them). A signal (INT/TERM) still goes
  through `triggerShutdown`, which is what stops a blocking read.
- No JSON-RPC, storage or `Manager` change, no `DATABASE_VERSION` bump: nothing
  Snowdrop gates on changed, and the Java and native builds report the same version.

Verification: `ShutdownTest` (the flag is cleared; the hook does not run listeners after completion).
On the native build, `-vv` shows the old sequence (`JVM is shutting down`, `Triggering shutdown.`, then
the abort) replaced by `JVM is shutting down`, `Waiting for app to shut down`, `Exiting`, and exit status
0 with and without a pending `startLink`. `scripts/build-signal-cli.sh` smoke-tests both builds with a
`version` round trip over `jsonRpc` that must end with exit status 0 once stdin closes.

## 0023: synced message-request answers

When the user accepts, deletes, blocks or reports a message request on their phone, the phone sends a
`SyncMessage.messageRequestResponse`. libsignal-service parses it and `MessageEnvelope.Sync` already
carried it as `messageRequestResponse`, but upstream's `JsonSyncMessage` has no field for it, so it never
reached a JSON-RPC client. A client linked to the same account could not tell that a request it was still
showing had been answered elsewhere.

- `JsonSyncMessage` gains `messageRequestResponse` (omitted when the sync carries none), built by the new
  `JsonSyncMessageRequestResponse`:
  `{"type":"ACCEPT","threadAci":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","threadE164":"+15551234567"}` for a
  person, `{"type":"SPAM","groupId":"AQIDBAUGBwgJCgsMDQ4PEA=="}` for a group.
  - `type` is the protobuf enum name: `ACCEPT`, `DELETE`, `BLOCK`, `BLOCK_AND_DELETE`, `UNBLOCK_AND_ACCEPT`,
    `SPAM`, `BLOCK_AND_SPAM` or `UNKNOWN`. `SPAM` and `BLOCK_AND_SPAM` reach the JSON only with
    `patches/signal-service-java` 0003: stock libsignal-service decodes those two wire values as `UNKNOWN`.
    The wire enum has no `UNBLOCK_AND_ACCEPT`, so that name never appears from a real message.
  - `threadAci` and `threadE164` are present when the stored recipient has them; `groupId` is base64, like
    every other group id in the JSON.
- Nothing else changes here; 0026 makes signal-cli act on the message.
- No `Manager`, storage or `DATABASE_VERSION` change.

Verification: `JsonSyncMessageRequestResponseTest` (the exact JSON for a person with and without a number, a
group, and a sync without one). Not verified against a real phone. First shipped as build
`0.14.8-snowdrop-history.25`.

## 0024: synced verification changes

Marking a safety number verified or unverified on the phone sends a `SyncMessage.verified`.
`IncomingMessageHandler` already applies it to the identity store, but, as for message requests, upstream
never put it in the JSON.

- `MessageEnvelope.Sync` gains `verified` (`Verified(destination, state)`, `state` is `DEFAULT`, `VERIFIED`
  or `UNVERIFIED`), and `JsonSyncMessage` gains `verified` (omitted when absent), built by `JsonSyncVerified`:
  `{"destinationAci":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","destinationNumber":"+15551234567","state":"VERIFIED"}`.
- The identity key in the message is deliberately not exposed, in the API record or the JSON.
- `DbusManagerImpl`, the only other place that builds a `Sync`, passes an empty value.
- The identity store handling is unchanged. No storage or `DATABASE_VERSION` change.

Verification: `JsonSyncVerifiedTest` (the exact JSON, all three states, no key or identity field, absent when
not sent). Not verified against a real phone. First shipped as build `0.14.8-snowdrop-history.25`.

## 0025: `getAttachment` without whole-file copies

`getAttachment` did `readAllBytes()`, `Base64.encodeToString` and then put the String in a Jackson tree
(`valueToTree`), which the writer serialised again. For a 150 MB attachment that is the 150 MB of bytes, the
200 MB encoded String, and the transient copies the encoder and the serialiser make of it: about 750 MB at
the peak (an estimate, not measured), all of it for a payload that sits in a file.

- The JSON-RPC layer already writes each response straight to the output `Writer` (`JsonWriterImpl` calls
  `writeValue(writer, response)`), so only the result had to stop being materialised. The new
  `JsonStreamedAttachmentData` implements Jackson's `JsonSerializable`: when it is serialised it writes
  `{"data":` and then `JsonGenerator.writeBinary` Base64-encodes the attachment stream directly into the
  output in small chunks. The wire format is unchanged: the same `data` field, standard Base64 with padding
  and no line breaks (`JsonAttachmentData` is still used by `getAvatar` and `getSticker`).
- `SignalJsonRpcCommandHandler.runCommand` wraps such a result in a `POJONode` instead of `valueToTree`, so
  the stream is only read when the response is written. The result owns the stream and closes it once
  written; it is also closed if the command fails afterwards (an error's `data` never carries a streamed
  result) or when a request without an `id` drops its response (`JsonRpcReader`).
- The plain-text output of `getAttachment` keeps the old read-then-encode path, it is only for the CLI.
- A streamed response keeps `JsonWriterImpl`'s lock while it is written, so notifications wait for it; this
  was already the case for the big String, but the lock is now held for the read as well.
- A read error part-way through a file-backed attachment can no longer become a JSON-RPC error, because the
  response line has begun. Two things limit the damage. `getAttachment` reads the first byte before it
  starts (`JsonStreamedAttachmentData.of`), so an unreadable file is still an ordinary error. And if a
  write does fail part-way, `JsonWriterImpl` ends the broken line with a newline and flushes, so the next
  message (a `receive` notification, say) is on a line of its own, and then, for a JSON-RPC response with an
  id, writes a well-formed error response (`-32603`, "Failed to write the response") for that same id on the
  next line, so the client's request fails at once instead of waiting for a timeout. Only if that write fails
  too (the output itself is gone) does it throw.
- A streamed result is closed in a `finally` whenever its response is not written: on the single, batch and
  HTTP paths, for a request without an `id`, and when an error replaces it.
- Ordinary attachments already come back from `Manager.retrieveAttachment` as a `FileInputStream`.
  The two history paths did not: `HistoryAttachment.download` and `retrieveBackfilledHistoryAttachment` read the
  whole attachment (up to 100 MiB) into a `byte[]` and returned a `ByteArrayInputStream`. They now download
  and verify (size and integrity hash) into a temporary file, exactly as before, and return a
  `TempFileInputStream` over it that deletes the file on close. Nothing is returned for an attachment that
  fails a check, and a failure leaves no file behind, including when creating the second of the two temporary
  files fails (the first is deleted). This costs temporary disk (the plaintext, next to the
  ciphertext the downloader already wrote) instead of heap. `HistoryAttachment.download` still returns bytes
  for its tests.
- **Where the plaintext lives.** These two files hold decrypted data, so they are not created in
  `java.io.tmpdir` (`/tmp`, possibly on disk). `IOUtils.createPrivateTempFile()` creates them in
  `<config dir>/snowdrop-tmp/` (the directory signal-cli is given with `--config`), mode 0700, files 0600.
  `SignalAccountFiles` sets the directory when it is constructed and deletes everything left in it by an
  earlier run, so a crash or SIGKILL leaves no plaintext behind after the next start. These files have no
  delete-on-exit registration (which also grew without bound); the stream deletes its file when closed. When
  Snowdrop's vault is on, the config dir is the tmpfs runtime dir, so the plaintext stays in RAM and goes
  with it. `snowdrop-tmp` is not one of the vault's synced top-level directories (`data`, `attachments`,
  `avatars`, `stickers`), so it is never synced. Without a configured directory (library use, tests) the
  system temp directory is used.
- Upstream's own temporary files (`IOUtils.createTempFile()`, in `java.io.tmpdir`, with delete-on-exit) are left
  alone: the download target for an attachment (`AttachmentHelper.retrieveAttachment`) and for a group or
  profile avatar (`GroupHelper`, `ProfileHelper`) hold the encrypted CDN bytes, but `SyncHelper.sendGroups`
  and `sendContacts` write the plaintext group and contact lists to one before uploading them. Those two are
  upstream behaviour and not changed here.
- No storage or `DATABASE_VERSION` change.

Peak memory for a 150 MB ordinary attachment, estimated: before about 750 MB on top of the process
baseline, after the fixed-size buffers of the encoder and the output writer (well under 1 MB). For a 100 MiB
history attachment: before the whole `byte[]`, after a 64 KiB copy buffer.

Verification: `JsonStreamedAttachmentDataTest` (the same bytes as `JsonAttachmentData` for every padding case
and sizes above the encoder's buffer, a 96 MiB stream written to a counting writer, the full JSON-RPC
response line from `GetAttachmentCommand` and the error path), `TempFileInputStreamTest`,
`HistoryAttachmentTest.streamsAVerifiedFileAndRefusesAWrongSize`, `PrivateTempFileTest` (the directory is
created 0700 and swept, files are staged in it), and in `JsonStreamedAttachmentDataTest` a stream that fails
mid-way leaves a terminated line and the next message intact and answers the request id with an error
line, and an unreadable stream is refused up front. `HistoryAttachmentTest` also covers the second temporary
file failing to be created.
First shipped as build `0.14.8-snowdrop-history.25`.

## 0026: apply synced message-request answers

Upstream signal-cli ignores `SyncMessage.messageRequestResponse`; only the `blocked` list sync updates its
block state, and that only ever blocks. So after the user unblocked or accepted someone on their phone,
this device kept dropping that person's messages (`IncomingMessageHandler` skips blocked senders), and a
block given on the phone took effect here only if the phone also sent a blocked-list sync.

`IncomingMessageHandler` now applies the answer to the local stores, as Signal's own clients do:

- `BLOCK`, `BLOCK_AND_DELETE` and `BLOCK_AND_SPAM` block the contact or group. `BLOCK_AND_SPAM` only arrives
  with `patches/signal-service-java` 0003 (stock decoding turned it into `UNKNOWN`).
- `ACCEPT` and `UNBLOCK_AND_ACCEPT` unblock it if it was blocked; for a person they also turn on profile
  sharing. The wire enum has no `UNBLOCK_AND_ACCEPT` (values 0 to 6 only), so an unblock made on the phone
  arrives as `ACCEPT`; the `UNBLOCK_AND_ACCEPT` branch is unreachable from the wire and kept because it is
  harmless.
- `DELETE`, `SPAM` and `UNKNOWN` change nothing here (deleting a chat is the client's business).

Nothing is sent: the phone has already done its part. For a person only `setContactBlocked` and
`setContactProfileSharing` run, which write the contact store. For a group the handler reads the group from
`GroupStore` and saves the block flag there directly, so it neither fetches a group from the group server
(`GroupHelper.getGroup` can) nor enqueues a storage sync (`setGroupBlocked` does); a group that is not in the
store is skipped. The call is wrapped so that an error while applying (logged as a warning with the exception
class only) cannot abort handling of the rest of the sync message. No `DATABASE_VERSION` change. Not verified
against a real phone. First shipped as build `0.14.8-snowdrop-history.25`; `SPAM` and `BLOCK_AND_SPAM` and the
group change arrived in `.26`.

## The native build

`scripts/build-signal-cli.sh --native` (with `SNOWDROP_GRAALVM` set to a GraalVM CE JDK 25 home that has
`bin/native-image`) compiles the patched classes into one executable under `dist-native/signal-cli/`,
after the Java build. It needs about 5 GiB of RAM and about 6 minutes. Without `SNOWDROP_GRAALVM` the
script builds only the Java build and prints a one-line hint. `--install` installs `dist-native` next to
the Java build (`<app data>/bin/signal-cli-history-native/`, with its own `.previous` copy) and never in
place of it; a Java build installed without a matching native one retires the installed native one, and
an install whose `PROVENANCE.txt` is identical to what is there is left alone.

What the native step adds, all under `patches/signal-cli/native/` and generated or copied into the work
tree at build time (nothing is patched into signal-cli for it):

- `gen-native-metadata.py` scans the compiled classes of the patch's JSON-RPC result types, the history
  types and the backup protobufs and registers every one for reflection in full (upstream's own metadata
  lists some of them member by member, which goes stale as soon as a patch adds a field). Run it again
  whenever a patch adds such a type: the build does that every time.
- `awt-reachability-metadata.json` is the JNI access the JDK's ImageIO/AWT code (`AttachmentUtils`
  probes an attachment image's size) needs inside an image, recorded with the native-image tracing agent.
- `native-image.properties` leaves libsignal's embedded JNI libraries out of the image (about 270 MB for
  all platforms); the linux-x86_64 one is shipped stripped beside the binary as `libsignal_jni.so`, where
  `System.loadLibrary` finds it, together with the JDK's AWT/ImageIO shim libraries the compiler emits.

`dist-native/signal-cli/PROVENANCE.txt` has the same fields as the Java build's (upstream commit, the
build script's hash, every patch's hash, signal-service-java's) plus the GraalVM version and the JNI
library's hash, so `desktop-update` decides rebuilds and installs from it the same way. The build
smoke-tests the result: the version string and a `version` JSON-RPC round trip with a clean exit on stdin
EOF. A Java rebuild deletes a native build made from the previous one. It is Linux x86-64 only. Measured
against the Java build with no account (medians): first JSON-RPC reply in 29 ms instead of 1360 ms, idle RSS 53 MiB
instead of 138 MiB.

Snowdrop runs the native build only when asked to (`SNOWDROP_SIGNAL_CLI_NATIVE=1`) and falls back to the Java one when it cannot run (see
docs/DESKTOP.md, "Native build and the Java fallback").

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
