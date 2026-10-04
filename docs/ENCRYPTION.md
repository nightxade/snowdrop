# Encrypted local storage

Status: **design, under construction**. This document is the contract the implementation follows. It also explains to users what is and isn't protected.

## Goals

1. Nothing sensitive is written to disk in plaintext. That covers Signal keys and sessions, contacts and groups, message history, drafts and attachments.
2. Unlocking is automatic in normal use and needs no typing, as with Signal Desktop.
3. Changing keyrings doesn't have to mean starting over. With an (optional, recommended) recovery key, moving from KWallet to GNOME Keyring or KeePassXC, or recovering from a wiped keyring, takes one prompt. Without one, the worst case is a fresh start: see *What a fresh start loses*.
4. Failures are loud. Snowdrop never silently falls back to plaintext and never silently creates a key that orphans existing data.
5. "Erase all local data" really erases it.

## Threat model

| Threat | Protected? |
|---|---|
| Stolen laptop or copied disk/backup, keyring locked or machine off | **Yes.** Everything on disk is ciphertext. |
| Another local user account | **Yes.** The data is encrypted, and the directories are `0700`. |
| Malware running as you while you're logged in | **No.** It can ask the keyring for the secret or read process memory. Signal Desktop has the same limit. |
| Memory paged to an unencrypted swap partition | **No.** Mitigate with encrypted swap or zram. Signal Desktop has the same limit. |
| Signal's servers | Out of scope here. Signal's end-to-end encryption covers this. |

If the keys are ever compromised, remove the device in your phone's Signal (Settings → Linked devices). That invalidates the stolen copy.

**Rollback is out of scope.** Someone who can *write* to your home directory could restore an older `keys.json` or vault generation. That attacker is effectively "malware running as you", and a rollback reveals nothing new:
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
  - A random 32-byte secret stored through the **freedesktop Secret Service API** (`org.freedesktop.secrets`), under service `local.snowdrop.desktop`, account `keyslot-v1`.
  - This isn't tied to KWallet. KWallet, GNOME Keyring, KeePassXC (Secret Service integration) and oo7 all implement the API. macOS Keychain and Windows Credential Manager are used on those platforms.
- **Recovery slot (optional, recommended):**
  - A random recovery key with 160 bits of entropy, displayed as 8 groups of 5 Crockford-base32 characters, plus one checksum group that catches typos before any KDF runs.
  - It's the escape hatch for a keyring change.
  - Setup suggests creating one and explains why: "If you ever switch keyrings or reinstall, this lets Snowdrop unlock your data. Without it you'd have to re-link and would lose this computer's message history and your Snowdrop settings." It can be skipped and created later in Settings.
  - KDF: Argon2id, m = 19 MiB, t = 2, p = 1. That's the OWASP minimum, plenty for 160-bit input.
- **Passphrase slot (optional):**
  - For people who don't want a keyring at all; they're asked at every launch.
  - Uses Argon2id with m = 64 MiB, t = 3, p = 1, stored per slot so it can be tuned.
- **Wrapping:** XChaCha20-Poly1305, with 24-byte random nonces.
  - The AAD is the canonical encoding of the slot's *entire* metadata: type, version, KDF algorithm, parameters and salt.
  - So editing a slot's KDF parameters, or swapping slots, fails authentication loudly instead of silently changing behaviour.
  - `keys.json` also records a random `vault_id` that is bound into every vault AAD.
- **Keyring availability:** every keyring call has a timeout of about 5 s. "No keyring service on this system" (e.g. a bare Hyprland session), "keyring locked or refused", and "keyring has no Snowdrop secret" are reported as distinct states, never as a hang.
- **Changing keyring providers:** the new keyring has no secret, so Snowdrop shows the unlock screen. Enter the recovery key or passphrase, and Snowdrop offers to "Remember on this device", which enrols a new keyring slot. No data is re-encrypted, and the old slot is replaced.

## signal-cli vault

signal-cli has no encryption of its own. So Snowdrop never lets its folder exist on disk in plaintext: it lives in a RAM-backed runtime dir while the app runs, and only an encrypted vault is persisted.

**Locations:**
- Vault: `<app data>/vault/`, containing `manifest`, `manifest.prev` and `blobs/<random-id>`.
- Runtime: `$XDG_RUNTIME_DIR/snowdrop/signal-cli/` on Linux. That directory is tmpfs, `0700`, and cleared at logout and shutdown.
  - If no RAM-backed dir is available (e.g. macOS or Windows, for now), the vault is unavailable and the app says so. It never decrypts to a disk path.

**Format:**
- Each file is a separate blob, encrypted with the vault key.
- Each blob's AAD is its blob id plus the vault id, so blobs can't be swapped or replayed between vaults.
- The manifest is encrypted with AAD `"manifest"` and a generation number. It maps each relative path to `{ blob id, size, mtime, sha256 }`, so file names and sizes stay hidden too.

**Restore (on launch, after unlock):**
1. Take an exclusive lock on `<app data>/snowdrop.lock`, so only one instance runs.
2. Decrypt the manifest and its blobs into the runtime dir. Verify every hash and write a `.restored-from` marker.
3. Spawn signal-cli with `--config <runtime dir>`.

**What signal-cli writes** (from its source):
- **`account.db`:** SQLite in WAL mode, with `-wal` and `-shm` sidecars.
- **`data/<account>`:** the main account file. It holds the device password, identity keys, profile key, storage key and so on. It's rewritten **in place** (seek, write, truncate, fsync) under a file lock, not via a temp file and rename.
- **`attachments/`, `avatars/`, `stickers/`:** media.

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

**When to sync:**
- About 2 s, debounced, after a receive batch is acknowledged or a send succeeds.
- After linking finishes.
- Every 60 s while there are unsynced changes.
- On shutdown, while still blocking exit.

**Attachment budget:**
- Restore hydrates everything except media; media is restored on demand.
- Snowdrop already proxies signal-cli requests. When a `getAttachment` names a file missing from the runtime dir but present in the vault, it's decrypted into place first, then the request continues.
- After each sync, media not read for 10 minutes is evicted from the runtime dir, oldest first, once the runtime media total exceeds 256 MiB. That's safe because every evicted file is already in the vault.
- **If the RAM-backed folder fills up mid-write:** signal-cli's write fails and Snowdrop surfaces a "Storage full" error. Eviction then runs immediately.

**Crash recovery:**
- If the runtime dir exists at launch and the lock is free, the previous session crashed, and the runtime copy is newer. Sync it into the vault first, then reuse it.
- After a reboot the runtime copy is gone, so at most the last few seconds are lost. That can mean a handful of messages from that window fail to decrypt.

**Migration:** an existing plaintext `<app data>/signal-cli/` is imported into the vault, verified, and then deleted.

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
- **localStorage:**
  - Everything is encrypted except a tiny bootstrap set: theme and density, to avoid a flash of the wrong theme before unlock.
  - The store hydrates into memory after unlock and writes through, encrypted.

## UX

1. **First run:** a "Protect your data" step before linking.
   - It shows the detected keyring ("Protected by GNOME Keyring" / "KWallet" / …). With no keyring, it explains the options: install one, or use a passphrase.
   - It **suggests** a recovery key, with one sentence on why (see *Recovery slot*).
     - **Create recovery key** shows the key with Copy and Save to file buttons. You confirm by typing its last group.
     - **Skip for now** continues, and leaves a dismissible reminder in Settings.
   - An advanced toggle lets you use a passphrase instead of the keyring.
2. **Normal launch:** unlocking is silent. If the keyring is locked, the OS keyring's own prompt appears.
3. **Unlock screen**, shown when the keyring is missing or empty, or in passphrase mode:
   - Fields for the recovery key or passphrase.
   - A "Remember on this device" checkbox, which enrols a keyring slot.
   - Clear copy about why the screen appeared (no keyring service / locked / secret missing).
   - When there's no recovery key or passphrase to offer, the only action is **Start fresh**, with the *What a fresh start loses* list.
4. **Settings → Privacy & security:**
   - Storage status (encrypted, plus the keyring provider).
   - Create a recovery key, or replace it (which removes the old slot).
   - Add or remove a passphrase.
   - Switch keyring (re-enrol).
   - **Erase all local data:** type-to-confirm. It reminds you to also remove the device on your phone.
5. **Erase:**
   1. Stop signal-cli.
   2. Delete the vault, runtime dir, `keys.json`, keyring entry, IndexedDB, localStorage and `signal-cli.log`.
   3. Return to the first-run flow.

## Implementation plan

Each step is a separately reviewed commit.

1. `secrets` (keyring slot via a `SecretStore` trait) and `aead` helpers.
2. `keyslots`: `keys.json` format, the three slot types, unlock, enrol and remove, plus recovery-key encoding.
3. `vault`: pure filesystem logic, with fault-injection tests. It covers:
   - restore and sync;
   - GC and generations;
   - the instance lock and crash recovery;
   - SQLite backup and per-file lock-and-validate copies;
   - on-demand media restore and eviction.
4. A storage service state machine (`NeedsSetup → Locked → Unlocked → Running`):
   - Tauri commands.
   - Wiring into the signal-cli service: runtime dir, sync triggers, shutdown sync.
   - Migration.
5. Web cache encryption in `src/core/persistence`, plus bootstrap ordering.
6. UI: setup step, unlock screen, the Privacy & security page, and erase. Docs.
7. A security review (crypto and vault; flows and UI), then fixes.
