# Architecture

Shrike is a single-page React app over a React-free core. The core owns the
domain model, the transport contract, state, persistence and every rule about
messages (ordering, read state, optimistic sends, plugins). The UI only reads
stores and calls services. One function, `createShrike` in
`src/app/createShrike.ts`, wires everything together and is the only place
that knows which transport is in use.

This page explains the layers, how data moves through them, and how to extend
the system with a new transport. The plugin API is in [PLUGINS.md](PLUGINS.md),
theming in [THEMING.md](THEMING.md), and the build history and design decisions
in [PLAN.md](PLAN.md) §8.

## Layers and dependency rules

```mermaid
flowchart TD
  main["src/main.tsx<br/>(entry)"] --> app
  app["app/<br/>composition root"] --> features
  app --> uiplugins
  app --> services
  app --> adapters
  features["ui/features/*<br/>product areas"] --> hooks
  features --> primitives
  features --> services
  uiplugins["ui/plugins<br/>built-ins with UI"] --> hooks
  uiplugins --> primitives
  uiplugins --> plugins
  hooks["ui/hooks<br/>React context + hooks"] --> services
  primitives["ui/primitives<br/>presentational only"]
  plugins["core/plugins<br/>runtime + registries"] --> services
  plugins --> commands
  services["core/services<br/>sync, send, history, notifications"] --> contract
  services --> persistence
  services --> stores
  adapters["core/backend/mock<br/>core/backend/signal-cli"] --> contract
  contract["core/backend/types.ts<br/>ChatBackend contract"] --> domain
  stores["core/stores<br/>zustand/vanilla"] --> persistence
  themes["core/themes"] --> stores
  commands["core/commands"] --> lib
  persistence["core/persistence"] --> domain
  domain["core/domain<br/>pure types + helpers"]
  lib["core/lib<br/>leaf utilities"]
```

An arrow means "may import". Arrows are transitive downwards (a feature may
also import `core/domain`, `core/stores`, `core/themes`…); the diagram shows
the main edges, not every one.

| Layer                     | Responsibility                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/lib`                | Typed `Emitter`, `Clock`/`Scheduler` (+ `ManualScheduler` for tests), `DisposableStore`, `ObservableList`, nonces.                          |
| `core/domain`             | Pure types (`Message`, `Conversation`, `Contact`…) and pure helpers (markdown → ranges, grouping, fuzzy, ids).                              |
| `core/backend/types.ts`   | The `ChatBackend` contract and `BackendEvents`.                                                                                             |
| `core/backend/mock`       | Seeded demo world with simulated activity.                                                                                                  |
| `core/backend/signal-cli` | JSON-RPC over HTTP + SSE adapter for a local signal-cli daemon ([SIGNAL_CLI.md](SIGNAL_CLI.md)).                                            |
| `core/persistence`        | `MessageRepository` (memory and IndexedDB), versioned key-value settings storage.                                                           |
| `core/stores`             | zustand vanilla stores, one slice per file, plus memoised selectors.                                                                        |
| `core/services`           | `SyncService`, `SendService`, `HistoryService`, `NotificationService`, `ReceiptBuffer`, history export.                                     |
| `core/commands`           | `CommandRegistry`, keybind parsing/matching (`KeybindDispatcher`), key layers (`KeyLayerStack`), core command ids.                          |
| `core/plugins`            | `PluginRuntime`, `Registries` (extension points), settings schemas, headless built-in plugins.                                              |
| `core/themes`             | Token names, built-in themes, the theme engine, the CSS sanitiser, theme import/export.                                                     |
| `ui/primitives`           | Buttons, menus, dialogs, `Slot`/`PluginBoundary`… Thin wrappers over Radix, cmdk, frimousse, dnd-kit, sonner.                               |
| `ui/hooks`                | `useShrike()` (`AppServices`), `useObservableList`, layout state, roving focus, focus targets, text surfaces.                               |
| `ui/features/*`           | One folder per product area: `rail`, `sidebar`, `chat`, `members`, `settings`, `switcher`, `onboarding`, `spaces`, `conversation`, `shell`. |
| `ui/plugins`              | Built-in plugins that render UI (Relative Timestamps, Message Tools, Pronoun & Notes Badge, Vim Mode, Keyword Alerts' UI half).             |
| `ui/styles`               | `tokens.css` (the Dusk base theme), `global.css`, `reset.css`.                                                                              |
| `app`                     | `createShrike`, `deferredBackend`, `deferredRepository`, `ShrikeProvider`, `App` (onboarding vs shell), dev tools.                          |

### The rules

These are enforced on every source file by `eslint.config.js`
(`import-x/no-restricted-paths` zones plus `no-restricted-imports`):

1. `core/**` must not import `ui/**` or `app/**`, nor `react`, `react-dom` or
   React-bound zustand entry points. Stores use `zustand/vanilla`, so services
   and plugins run headless (tests, workers).
2. `core/domain` and `core/lib` are leaves: they import nothing else from
   `core`.
3. `ui/primitives` must not import `ui/features`, `core/**` or `app/**`. They
   are pure presentational components.
4. A feature (`ui/features/<name>/**`) may import another feature only through
   that feature's `index.ts`.
5. The adapters under `core/backend/mock` and `core/backend/signal-cli` may
   only be imported by `app/` (the composition root). Test files may import
   the mock directly.
6. Named exports only (`no-restricted-syntax` on `export default`), and no
   import cycles (`import-x/no-cycle`).

`ui/features` and `ui/plugins` reach the composed app through
`AppServices` (declared in `ui/hooks/ShrikeContext.tsx`), which the concrete
`Shrike` satisfies structurally. That keeps features from importing `app/`.

### How lint proves the rules still fire

A boundary rule that silently stops matching (a resolver change, a typo in a
glob) is worse than no rule. `npm run lint` therefore runs
`eslint . && node scripts/verify-boundaries.mjs`. The script writes small,
uniquely named fixture files (`__boundary_<pid>_<n>__.ts`) into each layer,
lints them with the real config, and fails unless each produces exactly the
expected rule ids. For example, `core/domain` importing `@/core/services` must
report `import-x/no-restricted-paths`; `core/services` importing `react` must
report `no-restricted-imports`; `ui/features/rail` importing `../sidebar` (the
index) must be clean. Fixtures are new files only, never existing ones, and are
removed on exit, on SIGINT/SIGTERM and at the next start. When you add a
layer or a rule, add a case to the `cases` table in that script.

## The composition root

`createShrike(options)` (synchronous) builds one instance:

1. Loads persisted state with `loadVersioned` and creates the stores
   (`createStores`), then binds them back to storage with `bindPersistence`
   (the `local` store is debounced: drafts change per keystroke).
2. Picks the transport from `settings.connection.backend`, **once per
   instance**. Switching transport means a new instance: `main.tsx` reloads
   the page (`App`'s `onBackendChange`).
   - `mock` (also before the user has chosen): in-memory repository, because
     the demo world is regenerated relative to "now" on each launch.
   - `signal-cli`: IndexedDB repository (`shrike-signal-cli`), because the
     daemon keeps no history. Falls back to memory when IndexedDB is missing.
3. Creates `Registries`, `SendService`, `SyncService` and `HistoryService`
   with explicit dependencies (backend, repository, stores, clock, scheduler,
   a shared `ReceiptBuffer`, an error reporter).
4. Creates the `PluginRuntime` with `withUiPlugins(BUILTIN_PLUGINS)` and a
   `PluginHost` (stores, a narrow backend facade, toasts, error reporting).
5. Creates `NotificationService` (fed by `sync.on('message')`, boosted by
   `registries.boostReason`) and the `KeybindDispatcher`.
6. Registers the core commands that need no view state (switcher, settings,
   shortcuts, member list, mark read, spaces, theme commands…). Commands that
   need view order are registered by the UI against the same ids
   (`useCoreCommands`, `useChatCommands`).
7. When given a `document`, applies appearance (`applyAppearance`) and
   re-applies it when appearance settings, Custom CSS, custom themes or plugin
   styles change. Safe mode passes empty Custom CSS and no imported themes.

`shrike.start()` then connects and runs the initial sync, restores the outbox,
seeds demo spaces (mock only, once), starts plugins and notifications. A
failed start (e.g. signal-cli has no account yet) can simply be retried.
`flush()` writes debounced state (called on `pagehide` and before reloads);
`dispose()` tears everything down.

### Lazy adapters: `deferredBackend` and `deferredRepository`

Each adapter is its own chunk, loaded with a dynamic `import()`. Services are
wired synchronously, so `createShrike` hands them a `deferredBackend(kind,
ready)`: a `ChatBackend` whose async methods await the adapter, whose `on()`
subscriptions made early attach once it loads, and whose `getStatus()` reports
`connecting` until then. Some code checks _which optional methods exist_ up
front (`SendService.capabilities`, the UI's `resolveAttachmentUrl` check), so
the per-kind optional methods are declared in `BACKEND_CAPABILITIES`
(`src/app/deferredBackend.ts`); a test in `deferredBackend.test.ts` fails if
that declaration drifts from the real adapters.

`deferredRepository(ready)` does the same for `IdbMessageRepository.open()`:
a `Proxy` that awaits the real repository before forwarding each call.

## Data flow

```mermaid
flowchart LR
  subgraph transport["Transport"]
    be["ChatBackend<br/>(mock / signal-cli)"]
  end
  subgraph core["core"]
    sync["SyncService<br/>ordered queue"]
    send["SendService<br/>optimistic + outbox"]
    hist["HistoryService<br/>windows"]
    repo[("MessageRepository")]
    stores["stores"]
    notif["NotificationService"]
  end
  ui["UI<br/>selector hooks"]
  be -- "events" --> sync
  sync --> repo
  sync --> stores
  sync -- "message" --> notif
  ui -- "actions" --> send
  send -- "send / edit / react" --> be
  send --> repo
  send --> stores
  ui -- "open / page / jump" --> hist
  hist --> repo
  hist -- "fetchHistory (mock)" --> be
  hist --> stores
  stores --> ui
```

The UI never subscribes to the backend. It reads stores through selector hooks
and calls services (or runs commands).

### Incoming: backend events → SyncService → repository and stores

Adapters translate protocol quirks into the domain-level `BackendEvents`
(`message`, `messageEdited`, `messageDeleted`, `messagePinned`, `reaction`,
`receipt`, `typing`, `readSync`, `conversationUpdated`, `contactUpdated`,
`status`, `checkpoint`). `SyncService` subscribes once:

- **Ephemeral events apply immediately:** `status`, `typing` and
  `contactUpdated` go straight to their stores.
- **Everything else goes through one ordered queue,** so an edit can never
  overtake the message it edits and a group refresh can't be overtaken by the
  next message. A handler that throws is reported and skipped; it never stalls
  the queue.
- **The queue is gated on the initial sync.** While `start()` loads self,
  contacts, conversations and read cursors (and, for the mock, seeds the newest
  history page per conversation), incoming events are parked in a backlog and
  replayed afterwards against real read cursors, so messages that arrived while
  the app was closed count as unread. The backlog survives a failed start.
- **A message** is upserted with `mergeDuplicate` (re-deliveries merge, never
  duplicate), appended to windows anchored to the present
  (`messages.appendLive`), bumps conversation activity and the sidebar preview
  (`conversations.noteLatest`), clears that author's typing state and, if new,
  updates unread/mention counts and emits `sync.on('message')`. That event
  feeds `NotificationService` and plugins' `ctx.backend.onMessage`. A
  re-delivery neither re-counts nor re-notifies.
- Edits older than the stored edit are ignored; deletes, pins and reactions
  update the stored row and the loaded window in place; receipts only ever
  advance status (`advanceStatus`); disappearing messages are purged on a timer
  and remembered as tombstones so a replay can't resurrect them.

### Ordering: `seq`, not timestamps

`(authorId, sentAt)` is a Signal message's **identity**
(`MessageId = "<authorId>:<sentAt>"`), but sender clocks can be wrong. Every
stored message therefore gets `seq`, a local, monotonically increasing arrival
sequence assigned by the repository:

- `upsert` gives a new message the next seq; merged duplicates keep theirs.
- Backfilled (older) history gets seqs _below_ everything stored
  (`upsertMany(…, { backfill: true })`).
- Optimistic sends reserve a seq with `allocateSeq()` so they keep their
  place when acknowledged.

The timeline, the repository index, read cursors, unread counts, the "new
messages" divider and conversation activity all use local arrival, so a sender
with a skewed clock can't bury a new message.

### Checkpoints and acknowledgements

Transports that can resume emit `checkpoint { cursor }` after each unit of
work (signal-cli: after the events produced by each SSE event). `SyncService` queues the
checkpoint like any other event, so it runs only after every preceding
repository write, and then calls `backend.acknowledge(cursor)`. Only then does
the signal-cli adapter persist the SSE `Last-Event-ID`
(`shrike.signal-cli.lastEventId.<account>`). A crash or reload therefore
re-delivers rather than skips; re-delivery is deduplicated by the merge. Events
dropped by `stop()` are never acknowledged. `deferredBackend` buffers
acknowledgements made before the adapter has loaded.

### Outgoing: the send pipeline

`SendService.send(draft)` takes an `OutgoingDraft` (raw composer text with a
U+FFFC per mention, the mention ids, quote, attachments, optional `format`):

1. **Transforms.** `registries.transform(draft)` runs plugin send transforms
   in registration order. A transform that throws, or returns something that
   isn't a valid draft for the same conversation (`isValidDraft`), is skipped.
2. **Compose.** Markdown (per `format`, else the user's setting) becomes
   Signal body + style ranges (`parseMarkdownToRanges`), and mention ids are
   attached to the placeholders (`attachMentions`).
3. **Optimistic row.** The message appears immediately as
   `pending:<nonce>` with a reserved seq, and is staged in the repository with
   an outbox entry (`stageOutgoing`). A reload restores outbox entries as
   _failed_ (`restoreOutbox`), so typed text is never lost.
4. **Transport.** `backend.send()` resolves with a `SendResult` (`sentAt`,
   optional resolved attachments, per-recipient failures). On error the row
   becomes `failed` (Retry / Delete in the UI; `send.retry`, `send.discard`).
5. **Reconcile.** The row is committed under its real id `<self>:<sentAt>`
   (`commitOutgoing`, merged with any sync echo that landed first). The
   `nonce` is kept so render keys stay stable across the id swap.
6. **Receipts that beat the ack.** Receipts can arrive before `send()`
   resolves. They are held in the shared `ReceiptBuffer` (60 s) and applied at
   reconcile.
7. **Queued operations.** Editing, reacting to or deleting a still-pending
   message shows the effect at once and replays the backend call against the
   real id after acknowledgement. On a failed (never sent) message an edit
   rewrites the outgoing input and a delete discards it.

`edit`, `react`/`toggleReaction`, `deleteForEveryone`, `adminDelete` and `pin`
follow the same optimistic shape (apply to the store, call the backend,
persist or revert); `deleteForMe` is local only. `setTyping` is best-effort:
it is sent at most every 10 s (`TYPING_REFRESH_MS`) and only when the user's
"Send typing indicators" setting and every plugin typing guard
(`registries.allowsTyping`) allow it. `send.capabilities` reports which
optional operations (`pin`, `adminDelete`) the transport supports.

### Reading: HistoryService and conversation windows

The repository is the source of truth; the messages store holds **windows**
onto it, one per conversation (`ConversationWindow`: `ids`, `byId`,
`hasMoreBefore`, `hasMoreAfter`, `anchoredToPresent`, `loading`, `loaded`),
capped at `WINDOW_CAP` (400) with eviction on the side far from the reader.

- `open(id)` snapshots the read cursor into `ui.unreadMarkers` (so the "new"
  divider doesn't move while auto-mark-read runs) and loads the newest page.
- `loadOlder` / `loadNewer` page from the repository; when local history runs
  out and the backend implements `fetchHistory` (only the mock), older pages
  are backfilled from it.
- `jumpTo(id)`, `jumpToFirstUnread`, `jumpToPresent` replace the window with
  one around the target; a window that isn't anchored to the present is
  _detached_ and live messages don't append to it (the UI jumps to present
  before sending).
- Paging coalesces with an in-flight page; a jump bumps a generation token
  that discards results of whatever was in flight. A load that ends anchored to
  the present catches up on messages stored meanwhile.
- In-place updates keep `ids` identity, so `createRenderItemsSelector`
  recomputes layout (`groupMessages`: day dividers, new divider, author groups)
  only when ids or the marker change; rows subscribe per message id.

**Read state.** A conversation is marked read only when its window is
anchored, its bottom is visible (`ui.scrolledUp[id]` is unset) and the window is
focused (`useReadTracking` in the list). `SyncService` applies the same rule
when deciding whether a new message is unread.

## Persistence

| What                                                                          | Where                                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Settings (`shrike.settings`, v3)                                              | `localStorage` via `loadVersioned` / `bindPersistence`                                 |
| Spaces, folders, categories (`shrike.spaces`)                                 | same                                                                                   |
| Pin / mute / archive / drafts, contact notes, reaction usage (`shrike.local`) | same, debounced                                                                        |
| Messages, read cursors, outbox                                                | `MessageRepository`: memory for the demo, IndexedDB `shrike-signal-cli` for signal-cli |
| signal-cli resume position and DM peers                                       | `shrike.signal-cli.lastEventId.<account>`, `shrike.signal-cli.peers.<account>`         |

Versioned data is stored as `{ v, data }`. Loading runs step-wise migrations,
then parses **field by field** against defaults, so one corrupt field falls back
alone; unusable data is copied to `<key>.backup` before defaults take over.
Protocol state (`Conversation`) and device-local state
(`LocalConversationState` in the `local` store) are separate, so a backend
update can never clobber a pin or mute; `ConversationView` combines them in
memoised selectors (`stores/views.ts`).

## How to add a backend adapter

A new transport (say, `matrix-bridge`) is a folder under `core/backend/` that
implements `ChatBackend`. Nothing above the contract changes.

1. **Create the folder** `src/core/backend/<kind>/` with an `index.ts` that
   exports the adapter class. Import only `@/core/domain`, `@/core/lib` and the
   contract types from `@/core/backend`.
2. **Add the kind** to `BackendKind` in `src/core/backend/types.ts`, and to
   `BackendChoice` plus its parser in `src/core/stores/settings.ts` (the
   persisted `connection.backend` value).
3. **Declare capabilities** in `BACKEND_CAPABILITIES`
   (`src/app/deferredBackend.ts`): exactly the optional methods your adapter
   implements. Add the kind to the capability test in
   `src/app/deferredBackend.test.ts`.
4. **Wire it in the composition root:** a branch in `createBackend`
   (`src/app/createShrike.ts`) that dynamic-imports the adapter, wraps it in
   `deferredBackend(kind, ready)` and picks a repository (IndexedDB through
   `deferredRepository` if the transport keeps no history).
5. **Keep it behind the boundary:** add the folder name to the `adapterZones`
   list in `eslint.config.js` (currently `['mock', 'signal-cli']`) so only
   `app/` may import it.
6. **Expose it in the UI:** the welcome screen (`ui/features/onboarding`) and
   Settings → Connection (`ui/features/settings/pages/ConnectionPage.tsx`) list
   the choices; `ConnectionBanner` names the transport.
7. **Test it** headless: drive it with a fake transport (see
   `core/backend/signal-cli/testing.ts` for a scriptable fake daemon) and boot
   it through `createShrike` with injected fakes (see
   `src/app/createShrike.signalCli.test.ts`).

### Contract checklist

- [ ] **Identity.** `Message.id` is `messageId(authorId, sentAt)`; every alias of
      the local account (number, UUID) maps to one self id; `Contact.id` is
      stable across sessions.
- [ ] **`send()`** resolves with the timestamp the network assigned
      (`SendResult.sentAt`); throws when nobody received the message; reports
      partial group failures in `recipientFailures` instead of throwing.
- [ ] **Own messages from other devices** arrive as `message` events with
      `authorId` = self (status `sent`); incoming messages have status `read`.
- [ ] **Edits** emit `messageEdited` with the _original_ `targetSentAt`;
      **deletes** emit `messageDeleted` (`deletedBy` for admin deletes).
- [ ] **Receipts** are for messages _we_ sent; `authorId` is the recipient.
- [ ] **Read on another device** emits `readSync` with message refs only (the
      sync engine resolves conversations).
- [ ] **A new conversation** is announced with `conversationUpdated` before its
      first message (the sync engine also synthesises unknown DMs).
- [ ] **Status** goes `connecting` → `online`, `offline` on retries, `error`
      when the connection is refused for good.
- [ ] **Ordering.** Emit events in protocol order; if one input produces several
      events (e.g. a group update → system line + `conversationUpdated`), emit
      them through one internal queue.
- [ ] **Resumable transports** emit `checkpoint` after each unit of work and
      persist the position only in `acknowledge()`; re-delivery must be safe.
- [ ] **Attachments** either carry a renderable `url`, or the adapter implements
      `resolveAttachmentUrl` and returns `blob:` URLs typed with their real type
      only for allow-listed raster image/audio/video types (never SVG or HTML).
- [ ] **Optional methods** (`fetchHistory`, `adminDelete`, `pinMessage`,
      `updateConversation`, `resolveAttachmentUrl`, `acknowledge`, `link`) are
      either implemented properly or absent, and match `BACKEND_CAPABILITIES`.
- [ ] **Errors** carry a string `kind` (duck-typed into `session.errorKind`), so
      the UI can show onboarding states like signal-cli's `no-account`.
- [ ] **`on()`** returns an unsubscribe; listener errors never break the
      adapter (use `Emitter` from `core/lib`).
- [ ] **No raw protocol objects** leave the adapter; validate untrusted input at
      the boundary (`unknown` + narrowing, see `signal-cli/validate.ts`).

## Testing

Tests are colocated (`*.test.ts(x)`) and run with Vitest in happy-dom. Time is
injected everywhere (`Clock`, `Scheduler`), so time-dependent code is tested
with `ManualScheduler` instead of real timers.

| Level             | What and how                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain            | Pure helpers: markdown → ranges, segments, grouping, fuzzy, message ops (`core/domain/*.test.ts`).                                                                                                |
| Stores            | Reducers, selectors, persistence parsing and migrations (`core/stores/*.test.ts`, `core/persistence/keyValue.test.ts`).                                                                           |
| Repository        | One suite runs against both repositories; IndexedDB through `fake-indexeddb` (`core/persistence/MessageRepository.test.ts`).                                                                      |
| Services          | Sync/send/history against the mock backend, including races and checkpoints (`core/services/*.test.ts`).                                                                                          |
| Adapters          | Mock world and events; signal-cli normaliser against hand-written envelope fixtures (`signal-cli/fixtures/envelopes.ts`), RPC/SSE/backend against the fake daemon (`testing.ts`).                 |
| Plugins           | Lifecycle, isolation, settings coercion, built-ins (`core/plugins/*.test.ts`, `ui/plugins/*.test.ts`, `ui/plugins/vim/**`).                                                                       |
| Composition       | `createShrike` on both transports, `deferredBackend` capabilities (`src/app/*.test.ts`).                                                                                                          |
| UI                | Testing Library on a real demo instance (`src/test/renderWithShrike.tsx`, `src/test/bootDemo.tsx`); an axe smoke test (`vitest-axe`) in `src/test/shell.test.tsx`.                                |
| Design invariants | Text contrast ≥ 4.5:1 on every surface of every built-in theme (`src/test/contrast.test.ts`); `tokens.css` ↔ `tokens.ts` in sync (`src/test/tokens-sync.test.ts`); licence list ↔ `package.json`. |

Running them:

```sh
npm test                                   # all suites once
npm run test:watch                         # watch mode
npx vitest run src/core/services           # one folder
npx vitest run -t "checkpoint"             # tests whose name matches
npm run typecheck && npm run lint && npm test && npm run build   # the full gate
```

Happy-dom has no layout, so scrolling, virtualisation jumps and focus after a
scroll were verified manually with browser screenshots during development;
they are not part of the automated suites.
