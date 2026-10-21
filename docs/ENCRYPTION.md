# Encrypted local storage

Status: **implemented** (desktop app only). This document is the contract the implementation follows. It also explains to users what is and isn't protected.

## Goals

1. Nothing sensitive is written to disk in plaintext. That covers Signal keys and sessions, contacts and groups, message history, drafts and attachments.
2. Unlocking is automatic in normal use and needs no typing, as with Signal Desktop.
3. Changing keyrings doesn't have to mean starting over. With an (optional, recommended) recovery key, moving from KWallet to GNOME Keyring or KeePassXC, or recovering from a wiped keyring, takes one prompt. Without one, the worst case is a fresh start: see _What a fresh start loses_.
4. Failures are loud. Snowdrop never silently falls back to plaintext and never silently creates a key that orphans existing data.
5. "Erase all local data" really erases it.

## Threat model

| Threat                                                             | Protected?                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen laptop or copied disk/backup, keyring locked or machine off | **Yes.** Everything on disk is ciphertext.                                                                                                                                                                                                                                                           |
| Another local user account                                         | **Yes.** The data is encrypted, and the directories are `0700`.                                                                                                                                                                                                                                      |
| Malware running as you while you're logged in                      | **No.** It can ask the keyring for the secret or read process memory. Signal Desktop has the same limit.                                                                                                                                                                                             |
| Memory paged to an unencrypted swap partition                      | **No.** Mitigate with encrypted swap or zram. Signal Desktop has the same limit.                                                                                                                                                                                                                     |
| A compromised webview calls `storage_erase_all`                    | **Accepted.** It's reachable from the webview (see "UX" §5), but a compromised webview could already read everything decrypted and send it anywhere, so this adds no new exposure. Erasing is also recoverable: re-link and your phone resyncs contacts and groups (see "What a fresh start loses"). |
| Signal's servers                                                   | Out of scope here. Signal's end-to-end encryption covers this.                                                                                                                                                                                                                                       |

### What a compromised webview can still do

The webview is the one part that handles decrypted content, so Snowdrop treats it as a trust boundary and narrows what it can ask the Rust side for, but can't remove its access to your messages. If page script were compromised (a malicious plugin, a bug in how incoming content is rendered):

- **Read and send anything the app can.** It sees the decrypted cache, and can send messages as you through `signal_cli_request`.
- **Not make signal-cli read local files.** `signal_cli_request` rejects any `attachment`, `previewImage`, `avatar` or custom-emoji attachment that isn't an inline `data:` URI, and a `quoteAttachment` with a preview-file part. (signal-cli itself would read any other string as a path and only blocks its own data directory, so this check is the protection. See `docs/SIGNAL_CLI.md`.) It can still send files whose bytes it already holds, and it can only call the allow-listed signal-cli methods.
- **Read a copied file only right after a real paste.** `clipboard_read_files` refuses unless Rust itself saw a paste keystroke (Ctrl+V, Ctrl+Shift+V, Shift+Insert) or the context menu open on the webview, within the last few seconds. Script can't forge those. It can still read the clipboard in that window, after a paste you did make.
- **Fetch the web cache key** (`storage_webcache_key`). That's by design: the key has to reach the page to decrypt the cache, and the page already holds the decrypted cache.
- **Erase local data** (`storage_erase_all`). The `"ERASE"` argument guards against accidents, not script. Erasing is recoverable by re-linking (see "What a fresh start loses"), but it does lose Snowdrop's own local data.
- **Read recent log lines** (`log_recent`). The log is written redacted (phone numbers, ids, keys, your home directory and long base64 are scrubbed), and a call returns a bounded amount. Redaction is pattern-based and a safety net, not a guarantee; call sites aren't supposed to log message content in the first place.
- **Change the passphrase or recovery code** while unlocked. These need the unlocked session, not your old secret.

If the keys are ever compromised, remove the device in your phone's Signal (Settings → Linked devices). That invalidates the stolen copy.

**Rollback is out of scope.** Someone who can _write_ to your home directory could restore an older `keys.json` or vault generation. That attacker is effectively "malware running as you", and a rollback reveals nothing new:

- An old vault only makes signal-cli's sessions stale, which can cause decryption failures.
- An old `keys.json` can only reinstate a recovery key you already held.
- After a suspected compromise, the remedy is the same as above: erase, re-link and remove the old device.

### What a fresh start loses

You get here by losing the keyring secret with no recovery key and no passphrase. The data can't be decrypted by anyone, including you. "Start fresh" erases it and you re-link.

- **Comes back:** your Signal identity on this computer (as a new linked device), plus contacts and groups, which sync from your phone.
- **Gone:**
  - This computer's copy of message history. Your phone keeps its own, but Signal doesn't resend old messages to a new linked device.
  - Snowdrop's own data: settings, theme, spaces/folders, drafts, keyword alerts, and contact notes and pronouns.

## Key hierarchy (LUKS-style keyslots)

```
                 ┌──────────── keyslots (keys.json, on disk) ────────────┐
 OS keyring ───▶ │ keyring slot:    wrap(DEK, keyring secret)            │
 recovery key ─▶ │ recovery slot:   wrap(DEK, KDF(recovery key))         │──▶ DEK (data key, 32 B, in memory only)
 passphrase ───▶ │ passphrase slot: wrap(DEK, Argon2id(passphrase))      │      │
 (optional)      └───────────────────────────────────────────────────────┘      ├─ HKDF "snowdrop/vault/v1"    → vault key
                                                                                └─ HKDF "snowdrop/webcache/v1" → web cache key
```

- **DEK:** 32 random bytes, generated once. It never touches disk unwrapped and is zeroized on drop.
- **`keys.json`:** lives in the app data dir. It holds only wrapped DEKs and KDF parameters, so it's safe to back up.
- **Keyring slot:**
  - A random 32-byte secret stored through the **freedesktop Secret Service API** (`org.freedesktop.secrets`), under service `local.snowdrop.desktop`.
  - This isn't tied to KWallet. KWallet, GNOME Keyring, KeePassXC (Secret Service integration) and oo7 all implement the API. macOS Keychain and Windows Credential Manager are used on those platforms.
  - **Every enrolment gets its own keyring account**, `keyslot-<entry>`, where `entry` is a fresh random id generated at setup or re-enrolment time — never a single fixed account. `entry` is recorded alongside the slot in `keys.json` and bound into that slot's AAD, so repointing a slot at a different (even valid) account fails authentication loudly rather than silently accepting the wrong secret.
  - Enrolling (first setup, or "Remember on this device"/"Re-save key to this keyring" later) generates a new entry id and secret, writes it to the keyring, saves `keys.json` pointing at it, and only _then_ best-effort deletes the old entry's keyring account. A write from a call that already timed out can therefore only ever land on an account nothing references — never overwrite the one `keys.json` currently points at.
  - Orphaned accounts (an interrupted setup, a timed-out zombie write, a superseded entry whose best-effort delete itself failed) are harmless: nothing references them, and "Erase all local data" deletes whichever account is currently referenced regardless.
- **Recovery slot (optional, recommended):**
  - A random recovery key with 160 bits of entropy, displayed as 8 groups of 4 Crockford-base32 characters, plus one checksum group of 4 that catches typos before any KDF runs.
  - It's the escape hatch for a keyring change.
  - Setup suggests creating one and explains why: "If you ever switch keyrings or reinstall, this lets Snowdrop unlock your data. Without it you'd have to re-link and would lose this computer's message history and your Snowdrop settings." It can be skipped and created later in Settings.
  - KDF: Argon2id, m = 19 MiB, t = 2, p = 1. That's the OWASP minimum, plenty for 160-bit input.
- **Passphrase slot (optional):**
  - For people who don't want a keyring at all; they're asked at every launch.
  - Uses Argon2id with m = 64 MiB, t = 3, p = 1, stored per slot so it can be tuned.
  - A new passphrase must be at least 8 characters, checked in Rust as well as in the UI (unlocking never applies the minimum, so nobody is locked out). On load, KDF parameters outside sane bounds (m up to 512 MiB, t up to 10, p up to 8) are rejected as a corrupt `keys.json`, so a tampered file can't make the app allocate gigabytes before the authentication check fails.
- **Wrapping:** XChaCha20-Poly1305, with 24-byte random nonces.
  - The AAD is the canonical encoding of the slot's _entire_ metadata: type, version, keyring entry id (for the keyring slot) or KDF algorithm/parameters (for recovery/passphrase), and salt.
  - So editing a slot's KDF parameters, repointing a keyring slot at a different account, or swapping slots, fails authentication loudly instead of silently changing behaviour.
  - `keys.json` also records a random `vault_id` that is bound into every vault AAD.
- **The last unlock method can't be removed.** Removing the recovery slot, or the passphrase slot, is refused if doing so would leave `keys.json` with zero slots at all (no keyring, recovery or passphrase left). This is checked dynamically against whatever's actually left, not just "is there a keyring" — e.g. with only a recovery and a passphrase slot, removing either one is fine, but removing the second is refused.
- **Keyring availability:** a fast probe (about 2 s) checks whether `org.freedesktop.secrets` is even owned on the session bus before every real call; if not, Snowdrop reports "no keyring service" immediately rather than waiting. Once something answers, the real get/set/delete gets a generous timeout (about 120 s), because a _locked_ wallet shows its own unlock prompt, which can legitimately take a while to answer — that's different from "nothing is there at all", and the two are never confused with each other (a locked keyring is never misreported as "no Snowdrop secret", which would otherwise incorrectly route to "Start fresh"). The probe itself only runs on Linux; macOS Keychain and Windows Credential Manager have no equivalent question to ask first.
- **Changing keyring providers:** the new keyring has no secret, so Snowdrop shows the unlock screen. Enter the recovery key or passphrase, and Snowdrop offers to "Remember on this device", which enrols a brand-new keyring slot (new entry id, new secret) as described above. No data is re-encrypted.

## signal-cli vault

signal-cli has no encryption of its own. So Snowdrop never lets its folder exist on disk in plaintext: it lives in a RAM-backed runtime dir while the app runs, and only an encrypted vault is persisted.

**Locations:**

- Vault: `<app data>/vault/`, containing `manifest`, `manifest.prev` and `blobs/<random-id>`.
- Runtime: `$XDG_RUNTIME_DIR/snowdrop/signal-cli/` on Linux. That directory is tmpfs, `0700`, and cleared at logout and shutdown.
  - If no RAM-backed dir is available (e.g. macOS or Windows, for now), the vault is unavailable and the app says so. It never decrypts to a disk path.

**Format:**

- Each file is a separate blob at `blobs/<random 16-byte hex id>`, encrypted with the vault key under AAD `"snowdrop/vault/blob/v1" || vault_id || blob id`, so blobs can't be swapped or replayed between vaults or between each other's paths.
- The manifest is encrypted under AAD `"snowdrop/vault/manifest/v1" || vault_id`; the generation number lives in the plaintext, not the AAD. It maps each relative path to `{ blob, size, mtime_ns, sha256 }`, so file names and sizes stay hidden too.

**Restore (on launch, after unlock):**

1. Take an exclusive lock on `<app data>/snowdrop.lock`, so only one instance runs.
2. Decrypt the manifest and its blobs into the runtime dir. Verify every hash and write a `.restored-from` marker.
3. Spawn signal-cli with `--config <runtime dir>`.

**What signal-cli writes** (from its source):

- **`account.db`:** SQLite in WAL mode, with `-wal` and `-shm` sidecars.
- **`data/<account>`:** the main account file. It holds the device password, identity keys, profile key, storage key and so on. It's rewritten **in place** (seek, write, truncate, fsync) under a file lock, not via a temp file and rename.
- **`attachments/`, `avatars/`, `stickers/`:** media.

`data/`, `attachments/`, `avatars/` and `stickers/` are the _only_ top-level
directories `PathConfig.createDefault` (AsamK/signal-cli) ever writes, and
they're the only ones `sync`/`restore` ever read or write: anything else
under the runtime (or a legacy) dir is never synced, never restored, and
never counted as legacy data (see "Migration" below for why this matters).

**Sync (runtime → vault):**

1. Find changed files by size, mtime and hash.
2. Copy each file in the way that's safe for it:
   - **SQLite databases:** use the **SQLite online backup API**. It produces a consistent snapshot while signal-cli is writing, folding in any WAL content, so the `-wal` and `-shm` sidecars are never copied. On restore, only the `.db` file is written.
   - **Account file and other JSON:** take a shared lock on the file, the same kind signal-cli uses (an OFD `fcntl` lock), copy it, release the lock, then check that the copy parses as JSON. If it doesn't parse, retry with backoff. If retries are exhausted, skip the file this round and keep the previous blob.
   - **Media:** copy as is; signal-cli writes media once and doesn't change it.
3. Write each changed file to a **new** blob (never overwrite one), then fsync.
4. Write the new manifest to a temp file, fsync, rename `manifest` to `manifest.prev`, rename the temp file to `manifest`, then fsync the directory.
5. Garbage-collect blobs that neither `manifest` nor `manifest.prev` references.

A crash at any point leaves either the old or the new generation fully intact. `manifest.prev` is a one-generation fallback if the current one is unreadable.

A manifest entry whose relpath is absent from the runtime dir normally means it was deleted, so step 1 above also removes it from the manifest (and its blob is garbage-collected along with everything else at step 5) — **except** for a media relpath (`attachments/`, `avatars/`, `stickers/`) that this session has never actually seen materialized in the runtime dir: since media is restored lazily (see "Attachment budget" below), its absence just as often means "never hydrated yet" or "evicted" as "genuinely deleted", and the two are indistinguishable from the runtime dir's contents alone. `VaultSession` tracks which media relpaths it knows are materialized — seen present on a sync's own walk, or hydrated by `ensure_media` — drops a relpath from that record the moment `evict_media` removes it, and only lets a materialized-but-now-missing media relpath be treated as a real deletion. A non-media relpath is never special-cased this way.

**When to sync:**

- About 2 s, debounced, after a receive batch is acknowledged or a send succeeds.
- After linking finishes.
- Every 60 s while there are unsynced changes.
- On shutdown, while still blocking exit.

**Close handshake:** closing the main window doesn't exit immediately. Rust intercepts the close, emits `snowdrop://flush-before-close`, and waits for the frontend to answer with the `app_close_ready` command (the frontend's own cap on that wait is about 2 s) before actually exiting — with a 3 s fallback that exits anyway if nothing ever answers, so a stuck or absent frontend can never make the app unclosable. Either path still runs the same shutdown sequence afterwards (stop signal-cli, then the vault's own final sync).

**Attachment budget:**

- Restore hydrates everything except media; media is restored on demand.
- Snowdrop already proxies signal-cli requests. When a `getAttachment` names a file missing from the runtime dir but present in the vault, it's decrypted into place first, then the request continues.
- After each sync, media not read for 10 minutes is evicted from the runtime dir, oldest first, once the runtime media total exceeds 256 MiB. That's safe because every evicted file is already in the vault — and because an evicted file no longer counts as "materialized" (see "Sync" above), so the very next sync can't mistake its absence for signal-cli having deleted it.
- **If the RAM-backed folder fills up mid-write:** signal-cli's write fails and Snowdrop surfaces a "Storage full" error. Eviction then runs immediately.

**Crash recovery:**

- If the runtime dir exists at launch and the lock is free, the previous session crashed, and the runtime copy is newer. Sync it into the vault first, then reuse it. This sync runs before any `VaultSession` exists, so there's no record of what the crashed session had materialized — every media relpath absent from the reused runtime dir is kept unconditionally (never treated as deleted) rather than guessed at; an ordinary sync once the new session is running can tell a real deletion from a merely-unhydrated file and will catch up on it then.
- After a reboot the runtime copy is gone, so at most the last few seconds are lost. That can mean a handful of messages from that window fail to decrypt.

**Migration:** `<app data>/signal-cli/` is signal-cli's own plaintext data dir, left by a build that predates the vault — but only once it actually looks like signal-cli's data, not just any directory happening to exist at that path. Snowdrop requires a `data/` subdirectory specifically (signal-cli's own layout is exactly `data/`, `attachments/`, `avatars/`, `stickers/` — see above) before treating it as legacy data at all.

This distinction exists because of a real bug: a downloaded-but-never-yet-run signal-cli _binary_ used to be installed at this exact same path (`<app data>/signal-cli/<version>/signal-cli`, before `signal_cli_install.rs` moved installs under `<app data>/bin/`), and the old, cruder check — any directory at all — still treated it as legacy data. Every unlock synced the ~370 MB binary into the vault as if it were account data, garbage-collected the real account data's now-unreferenced blobs, and then deleted the "legacy dir" — taking the just-installed binary with it. Net effect: the linked account was lost and signal-cli had to be re-downloaded, every single launch.

Once a directory is confirmed legacy, only its allowlisted subtrees (`data/`, `attachments/`, `avatars/`, `stickers/`) are imported into the vault, verified by restoring into a scratch spot under the real RAM-backed runtime dir and comparing hashes, and only then deleted — never the whole legacy dir, which may hold something else Snowdrop doesn't manage. Migration is also skipped (leaving the legacy dir untouched, with a logged warning) if the vault already has a manifest: that would mean an account was already linked and synced through Snowdrop, and blindly importing a second, unrelated plaintext directory on top of it could only corrupt or shadow real data.

As defense in depth against a vault manifest left over from before this allowlist existed, `VaultSession::start` purges any manifest entry outside `data/`/`attachments/`/`avatars/`/`stickers/` (and garbage-collects its blob) on every unlock, and a restore sweeps any stray non-allowlisted entry out of the runtime dir afterwards. `sync` and `restore` themselves only ever read or write those four subtrees in the first place, so this is belt-and-suspenders rather than the primary fix.

**Not covered:**

- External-daemon mode, where you run signal-cli yourself.
- The `SNOWDROP_SIGNAL_CLI_DATA` override.

You own that data. The app shows a notice that it's unencrypted.

## Web cache

The message cache (IndexedDB) and the key-value store (localStorage) are encrypted with the web cache key, which is fetched once over IPC after unlock.

- It's imported as a non-extractable WebCrypto key, and the raw bytes are dropped.
- If code in the webview were compromised, it could read the decrypted cache anyway, so handing over the key adds no exposure.

- **Records:** AES-GCM, with a random 96-bit IV per record and the record id as AAD.
- **Indexed fields:**
  - Conversation ids are replaced by HMAC-SHA256(webcache key, id), so phone numbers and group ids don't leak.
  - Timestamps stay plaintext, because ordering and range queries need them. This leak is accepted and documented: the timing of messages, not their content or who they're with.
- **Outbox attachments:** an attachment's bytes, and its file name and type, are inside encrypted payloads. The `outboxAttachments` rows hold only an id and ciphertext. (Database version 4 removed the plaintext `fileName`/`contentType` fields earlier versions kept on those rows; the upgrade strips them in place, since the same metadata was already inside the outbox entry's encrypted payload.)
- **localStorage:**
  - Everything is encrypted except a tiny bootstrap set: theme and density, to avoid a flash of the wrong theme before unlock.
  - The store hydrates into memory after unlock and writes through, encrypted.
  - **Key names are blinded too.** Several keys are scoped by account (`snowdrop.local:signal-cli:<number or ACI>`, `snowdrop.spaces:…`, the signal-cli peers list and resume cursors), which would put your own phone number or ACI on disk in the clear even though the values are ciphertext. So every stored key name is `sk1.` plus HMAC-SHA256(webcache key, domain-separated key name), and the real name is sealed inside the value (`sd2:`, AES-GCM with the blinded name as AAD). Hydration reads the names back out of the values, so the stores still see their ordinary keys. Only the bootstrap set above keeps readable names. This needs the webcache key, which exists only after unlock, and nothing reads these keys before then.
  - **Migration:** a value written by an earlier version (plaintext, or `sd1:` under its readable name) is read at the first unlock, written under its blinded name, and only then removed under the old one, so an interruption can't lose it. If both copies exist after an interruption, the blinded one wins. Nothing else changes for the user.
  - In the browser build there is no vault and no key: values and key names stay as they were, readable, as with the rest of that build's cache.

## UX

1. **First run:** a "Protect your data" step before linking.
   - It shows the detected keyring ("Protected by GNOME Keyring" / "KWallet" / …). With no keyring, it explains the options: install one, or use a passphrase.
   - It **suggests** a recovery key, with one sentence on why (see _Recovery slot_).
     - **Create recovery key** shows the key with Copy and Save to file buttons. You confirm by typing its last group.
     - **Skip for now** continues, and leaves a dismissible reminder in Settings.
   - An advanced toggle lets you use a passphrase instead of the keyring.
2. **Normal launch:** unlocking is silent. If the keyring is locked, the OS keyring's own prompt appears.
3. **Unlock screen**, shown when the keyring is missing or empty, or in passphrase mode:
   - Fields for the recovery key or passphrase.
   - A "Remember on this device" checkbox, which enrols a keyring slot.
   - Clear copy about why the screen appeared (no keyring service / locked / secret missing).
   - When there's no recovery key or passphrase to offer, the only action is **Start fresh**, with the _What a fresh start loses_ list.
4. **Settings → Privacy & security** (desktop only):
   - **Status:** "Encrypted on this computer", with the key location (the keyring's friendly name, or "a passphrase"). If `vaultDisabled` (an external daemon, or `SNOWDROP_SIGNAL_CLI_DATA`), a clear warning that signal-cli's data is managed outside Snowdrop and isn't encrypted by it.
   - **Recovery key:** create it, or replace it (a confirm step notes the old key stops working immediately), or remove it (confirm). The reveal-and-confirm step is the same component the first-run flow uses. With no recovery key, a gentle, dismissible reminder explains why one helps.
   - **Passphrase:** add, change or remove, with the same validation and strength hint as first run.
   - **Keyring:** "Re-save key to this keyring" (`storage_enroll_keyring`), for after switching providers; the result (saved, or why not) shows inline.
   - **Erase all local data:** a danger-zone button opens a modal listing exactly what's deleted (the encrypted vault, recovery key, passphrase, keyring entry, and Snowdrop's own settings, spaces and drafts) and what isn't (your Signal account — remove this computer in your phone's Signal → Settings → Linked devices). Typing `ERASE` enables the confirm button.
5. **Erase:**
   1. Stop signal-cli, and stop this process's own buffered writes (nothing may re-create what's about to be deleted).
   2. Delete the vault, runtime dir, `keys.json`, the keyring entry `keys.json` referenced, the app log (`snowdrop.log` and its `.1` rotation — redacted, but still this account's history), a legacy plaintext `signal-cli/` dir if one is still waiting to migrate, and `bin/` — the installed signal-cli binary (and anything mid-download), kept there precisely so erase can wipe it without touching signal-cli's own data dir (`signal_cli_install.rs`; docs/DESKTOP.md). (Any other `keyslot-*` account for this service is left alone: the `keyring` crate has no cross-backend way to enumerate them, and an orphaned one is harmless — see "Keyring slot".)
   3. Restart the app (`app_restart`): the vault bridge and the single-instance lock (`snowdrop.lock`) are one-shot per process, so only a fresh process can return to a clean `needsSetup` boot.
   4. Until that restart happens, storage latches into a terminal "erased" state, distinct from `needsSetup`: `storage_status` still reports `state: "needsSetup"` (nothing is left to resume), but now also `restartRequired: true`, and every other storage command refuses with a clear error instead of quietly behaving as if nothing had ever been set up.
6. **Sign out** (Settings → Connection, the user panel's menu — sidebar
   bottom-left — and the `core.signOut` command): a lighter sibling of
   Erase, for "I'm done with this account, not with Snowdrop." Which of
   three flows runs is picked from the backend actually connected
   (`app/backends.ts`'s `BackendKind` plus whether `app.storageAdmin` is
   set), not from an unapplied Settings → Connection edit:
   - **Demo** ("Leave demo"): no scary dialog, at most a light confirm.
     `connection.backend` is set to `null` and Snowdrop reloads
     (`app.admin.reload()`, which awaits the encrypted settings write).
     Settings are kept. The demo's history is never persisted (it's
     `MemoryMessageRepository`, not an IndexedDB-backed one — see
     `HistoryStore` in `app/backends.ts`), so there's nothing shared with a
     real backend to separately clear.
   - **signal-cli through an external daemon** (the browser build, or the
     desktop app pointed at one — `vaultDisabled`/no `app.storageAdmin`):
     "Disconnect." Same as the demo — `connection.backend = null`, reload —
     plus a line in the dialog that Snowdrop never owned that daemon's data,
     so none of it is touched.
   - **signal-cli run by the desktop app itself:** "Sign out," with a
     confirm dialog in the style of Erase's but calmer (no type-to-confirm,
     since nothing needs the extra friction): "Sign out of Signal on this
     computer? This removes this computer's Signal keys, contacts and
     message history, and this account's contact notes, pins and drafts.
     Your Snowdrop settings, themes and spaces stay," plus a note that signal-cli can't unlink a device from the server
     itself, so the phone side needs doing by hand (Signal → Settings →
     Linked devices). That's also why `unregister` — the one signal-cli
     method that _could_ unlink a device — must stay off
     `commands.rs`'s `ALLOWED_METHODS`: it only stops delivery, so it would
     look like it worked while leaving the device listed on the phone. The
     steps here, strictly ordered:
     1. set `connection.backend` and `connection.account` to `null`;
     2. flush settings to encrypted storage and await it (`app.admin.persist()` —
        the same wait `reload()` does, factored out so this path doesn't also
        reload the page);
     3. `storage_sign_out` (below);
     4. stop syncing, then clear the signed-out account's scoped local data
        (`app.admin.clearAccountData()`, keys listed by `accountDataKeys` in
        `app/dataScope.ts`): contact notes, pins, mutes, archive flags and
        drafts, accepted and deleted message requests, recent stickers,
        reaction usage, custom emoji, backfill markers (all of `snowdrop.local:<scope>`),
        the imported-history record, the signal-cli peers list and resume cursors,
        and any `.backup` copies. Settings, themes and spaces are kept, as the
        confirm text promises; so is any other account's data;
     5. clear the local message cache (the repository's `clear()`), with a
        pending-clear flag for the next boot if that fails;
     6. restart the app (`app_restart`) — same one-shot-per-process reason as Erase.

   `storage_sign_out` (`storage.rs`'s `StorageService::sign_out`) reuses
   Erase's own hooks (`add_on_erase`: stop signal-cli, then discard the
   vault session _without_ a final sync — see `VaultBridge::discard`) and
   then deletes the vault (manifests, blobs), the runtime dir, and (like
   Erase) the app log, `snowdrop.log` and its `.1` rotation. Unlike Erase,
   `keys.json` and the keyring entry are left exactly alone, and so is
   `bin/` — the installed signal-cli binary: signing out ends this
   account's session, not Snowdrop's relationship with the copy of
   signal-cli it downloaded, so the next sign-in doesn't have to
   re-download it — so storage stays set up: a restart finds `keys.json` right where it was
   and, with a working keyring, unlocks the same way it did before — around
   a vault with nothing in it yet. Like Erase, this latches a terminal,
   restart-required state (`storage_status`'s `restartRequired: true`) for
   the same reason: the vault bridge and the single-instance lock are
   one-shot per process.

## Encrypted history export

Settings → Data & storage → Export history writes every stored message to a file, which would otherwise be plain JSON anywhere on disk. The dialog says so first (the file holds the messages as they are, anyone with it can read them, and Snowdrop cannot import it, so it is a copy and not a restore point). On the desktop the default is an **encrypted** export; a plain one stays available behind the same warning. The browser build has no Rust side, so it offers only the plain export.

- **Passphrase:** typed by the user, at least 8 characters (checked in the UI and again in Rust), confirmed. It is sent to the `storage_export_encrypt` command along with the JSON, used once, and never stored.
- **Crypto:** all in Rust (`export_crypto.rs`), reusing the passphrase keyslot's primitives: Argon2id (m = 64 MiB, t = 3, p = 1, fresh 16-byte salt) derives a 32-byte key, and XChaCha20-Poly1305 (`aead::seal`, fresh 24-byte nonce) seals the data.
- **File format** (`.snowdrop-export`, version 1):

  | Offset | Size | Field                                                          |
  | ------ | ---- | -------------------------------------------------------------- |
  | 0      | 4    | magic `SDEX`                                                   |
  | 4      | 1    | format version (`1`)                                           |
  | 5      | 1    | key derivation (`1` = Argon2id)                                |
  | 6      | 4    | Argon2id memory in KiB, little endian                          |
  | 10     | 4    | Argon2id passes, little endian                                 |
  | 14     | 4    | Argon2id lanes, little endian                                  |
  | 18     | 16   | salt                                                           |
  | 34     | …    | `aead::seal` output: `[0x01][24-byte nonce][ciphertext + tag]` |

  The 34-byte header is the AEAD's associated data (after the domain string `snowdrop/export/v1`), so lowering the KDF cost or changing any header byte fails authentication. KDF parameters read from a file are bounds-checked like `keys.json`'s. The plaintext is the same `snowdrop-history` JSON the plain export writes.

- **Reading it back:** `export_crypto::open_export` is the inverse, covered by tests (round trip, wrong passphrase, tampered header and body, other files, newer versions). Snowdrop has no import for exports and this does not add one.
- **Where the file lands:** the webview saves it through a download (`<a download>`), so the destination and the file's permissions are the platform's, not something Snowdrop sets; there is no file-system access from the webview to change that (see `capabilities/main.json`).

## Implementation plan

Each step was a separately reviewed commit. All seven are done.

1. ~~`secrets` (keyring slot via a `SecretStore` trait) and `aead` helpers.~~
2. ~~`keyslots`: `keys.json` format, the three slot types, unlock, enrol and remove, plus recovery-key encoding.~~
3. ~~`vault`: pure filesystem logic, with fault-injection tests. It covers:~~
   - restore and sync;
   - GC and generations;
   - the instance lock and crash recovery;
   - SQLite backup and per-file lock-and-validate copies;
   - on-demand media restore and eviction.
4. ~~A storage service state machine (`NeedsSetup → Locked → Unlocked → Running`):~~
   - Tauri commands.
   - Wiring into the signal-cli service: runtime dir, sync triggers, shutdown sync.
   - Migration.
5. ~~Web cache encryption in `src/core/persistence`, plus bootstrap ordering.~~
6. ~~UI: setup step, unlock screen, the Privacy & security page, and erase. Docs.~~
7. A security review (crypto and vault; flows and UI), then fixes — not yet done.
