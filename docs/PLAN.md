# Shrike — Build Plan

> A community-style desktop-class chat UI for the Signal network, driven by a
> local `signal-cli` daemon. Server-rail / channel-list / chat / member-list
> layout, deep theming, and a first-class plugin system.

This document is the source of truth for builders and reviewers. If an
implementation decision contradicts this plan, either follow the plan or update
the plan in the same change with a justification.

§0–§7 describe the product as built (updated after Phase 5 and the Vim-mode
work). §8 is the historical record of each phase's decisions and deviations;
where it is more detailed than §3–§5, §8 is right. Developer-facing guides:
`docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/THEMING.md`,
`docs/KEYBOARD.md`, `docs/SIGNAL_CLI.md`.

---

## 0. Product principles (in priority order)

1. **UX first.** Every surface must feel fast, legible, predictable and
   keyboard-drivable. Empty, loading and error states are designed, not
   afterthoughts. Nothing jumps; nothing blocks.
2. **Honest to Signal.** Signal is not Discord. We borrow the *information
   architecture* (rail → sidebar → chat → members) because it scales to many
   conversations, but we never invent features the protocol cannot back
   (e.g. no fake "online" presence, no voice channels). Local-only
   organisation (Spaces, categories) is clearly local.
3. **Privacy by default.** Everything stays on the machine. No telemetry, no
   CDN fonts, no remote link-preview fetching unless the user opts in.
4. **Composable code.** Small modules with explicit contracts; UI never talks
   to the transport directly; features are pluggable through typed extension
   points, not monkey-patching.

## 1. Legal / ethical guardrails

- Original name ("Shrike", after the small, sharp, quick songbird), original
  logo (a geometric shrike head drawn by us: straight cuts, hooked beak, the
  bird's black eye mask; no speech bubble, nothing like the Signal, Discord or
  Twitter/X marks), original palette (default accent: rufous `#d4744a`, the
  red-backed shrike's chestnut, *not* Discord blurple or Signal blue),
  original iconography (lucide-react, ISC).
- Name collisions are checked before adopting a name or logo: "Shrike" was
  checked against existing chat products. An earlier name collided with one
  and was dropped (see §8).
- No Discord or Signal assets, fonts (gg sans / Signal's Inter build), sounds,
  logos, copy, or trademarks in UI chrome. Text may say "works with Signal
  via signal-cli" descriptively, never implying endorsement.
- Fonts: **Inter** and **JetBrains Mono** via `@fontsource-variable/*` (OFL),
  bundled locally.
- `signal-cli` (GPL-3.0) runs as a separate process; we talk to it over its
  documented HTTP JSON-RPC API. We ship none of its code.
- Every dependency must be MIT / ISC / Apache-2.0 / BSD / OFL. Reviewer
  checks `package.json` additions.
- `scratch/` (outside the repo) holds reference clones; never copy code from
  them into `shrike/`.

## 2. Tech stack

| Concern            | Choice                                             | Why |
|--------------------|----------------------------------------------------|-----|
| Build              | Vite + TypeScript (strict, `noUncheckedIndexedAccess`) | fast, simple |
| UI                 | React 19                                            | ecosystem, a11y libs |
| State              | Zustand (vanilla stores + React bindings)           | tiny, composable slices, usable outside React (plugins) |
| Styling            | CSS Modules + CSS custom-property design tokens    | themes = token overrides; user CSS can target stable class hooks |
| A11y primitives    | Radix UI (Tooltip, Popover, ContextMenu, DropdownMenu, Dialog, ScrollArea not required) | correct focus/ARIA for free |
| Message list       | `react-virtuoso`                                    | reverse-scroll chat, variable heights, prepend without jump |
| Persistence        | `idb` (IndexedDB)                                   | signal-cli keeps **no history**; we must |
| Icons              | `lucide-react`                                      | ISC |
| Fuzzy search       | small in-house scorer (no dep)                      | ranking tuned to our data |
| Command palette    | `cmdk` (MIT)                                        | quick switcher / command list, accessible listbox |
| Drag & drop        | `@dnd-kit/core` + `@dnd-kit/sortable` (MIT)         | spaces/channel reordering with keyboard support |
| Emoji picker/data  | `frimousse` (MIT, unstyled, themeable) + `emojibase-data` | picker + `:shortcode:` autocomplete |
| Toasts             | `sonner` (MIT)                                      | notifications/errors |
| Floating UI        | `@floating-ui/react` (MIT)                          | autocomplete popover anchored to caret |
| QR                 | `qrcode` (MIT)                                      | device linking |
| Tests              | Vitest + Testing Library + happy-dom                | |
| Lint/format        | ESLint (typescript-eslint, react-hooks, import boundaries) + Prettier | |

**Rule:** prefer a well-maintained permissive OSS library over hand-rolling
anything with non-trivial a11y or interaction complexity (menus, focus traps,
virtualisation, DnD, pickers). Wrap each third-party UI lib behind a thin
`ui/primitives` component so it can be swapped later.

Package manager: **npm**. Node ≥ 20.

## 3. Architecture

```
shrike/src/
  main.tsx             # entry: safe mode, dev tools, mounts <App>
  app/                 # composition root: createShrike, deferredBackend/Repository, providers, App
  core/                # NO React imports allowed here
    domain/            # pure types + pure helpers (ids, time grouping, body ranges)
    lib/               # leaf utilities: typed Emitter, Clock/Scheduler, disposables, observable lists
    backend/           # ChatBackend contract + adapters
      types.ts
      mock/            # rich demo world with simulated activity
      signal-cli/      # JSON-RPC over HTTP + SSE event stream
    persistence/       # MessageRepository (memory + IndexedDB) + versioned key-value storage
    stores/            # zustand vanilla stores (one file per slice) + view selectors
    services/          # orchestration: sync engine, send pipeline, history paging, notifications
    plugins/           # plugin runtime, extension registries, headless built-in plugins
    themes/            # token definitions, built-in themes, theme engine, CSS sanitiser
    commands/          # command registry, keybinds, key layers
  ui/
    primitives/        # Button, Avatar, Tooltip, Popover, Menu, Modal, Slot, CommandPalette, Lightbox…
    hooks/             # React context (AppServices), useObservableList, layout, roving focus, text surfaces
    features/          # one folder per product area
      rail/            # spaces rail, folders
      sidebar/         # conversation list, categories, user panel
      chat/            # header, message list, message, composer, search/pins/mentions
      members/         # member list, profile popout
      settings/        # full-screen settings
      switcher/        # quick switcher (Ctrl+K)
      onboarding/      # welcome, connect, link device, account prompt
      spaces/          # create/edit space and folder dialogs
      conversation/    # shared conversation avatar, preview, menu + actions
      shell/           # layout, keyboard, core commands, modal host, toasts
    plugins/           # built-in plugins with a UI half (incl. vim/)
    styles/            # global.css, tokens.css (the Dusk theme), reset.css
  test/                # test utils, app-level tests
```

**Dependency rules (enforced by ESLint `import-x/no-restricted-paths` and
`no-restricted-imports`; details in `docs/ARCHITECTURE.md`):**
- `core/**` must not import `ui/**`, `app/**`, `react`/`react-dom`, or zustand's
  React entry points (stores use `zustand/vanilla`).
- `core/domain` imports nothing else from `core`; `core/lib` likewise.
- `ui/primitives` must not import `ui/features`, `core/**` or `app/**` (pure presentational).
- `ui/features/*` may import `core/**`, `ui/primitives`, `ui/hooks`, and
  another feature only through that feature's `index.ts`.
- Adapters under `core/backend/*` are only imported by `app/` (composition root)
  (test files may import the mock). `app/` may import `ui/`; features reach the
  composed app through `AppServices` (`ui/hooks`), never through `app/`.
- Named exports only; no import cycles.
- `scripts/verify-boundaries.mjs` (run by `npm run lint`) lints fixture files
  in each layer and fails if any of these rules stops firing.

### 3.1 Domain model (`core/domain`)

```ts
type ConversationId = string & { __brand: 'ConversationId' } // `dm:<aci|number>` | `group:<base64id>`
type MessageId = string & { __brand: 'MessageId' }           // `${authorId}:${sentAt}` (Signal identity); `pending:<nonce>` before ack

interface Contact { id: string /* ACI, else number */; number?: string; name: string; profileName?: string;
  about?: string; aboutEmoji?: string; color: string /* var(--shrike-avatar-N): a theme slot */;
  avatarUrl?: string; isSelf?: boolean; blocked?: boolean }

// Protocol state only. Local organisation lives in localStore (never sent to Signal).
interface Conversation { id: ConversationId; kind: 'direct' | 'group'; title: string;
  description?: string; avatarUrl?: string; memberIds: string[]; adminIds: string[];
  expireTimerSec: number; lastActivityAt: number }
interface LocalConversationState { pinned: boolean; muted: boolean | { until: number }; archived: boolean; draft?: string }
type ConversationView = Conversation & LocalConversationState   // what the UI renders (stores/views.ts)

type TextStyle = 'bold' | 'italic' | 'strikethrough' | 'monospace' | 'spoiler'
interface BodyRange { start: number; length: number; style?: TextStyle; mentionId?: string } // UTF-16 units

interface Quote { authorId: string; sentAt: number; text: string; ranges?: BodyRange[];
  attachments?: { contentType: string; fileName?: string }[] }

interface Message { id: MessageId; conversationId: ConversationId; authorId: string;
  sentAt: number /* identity only: never order by it */; receivedAt: number;
  seq?: number /* local arrival order, assigned by the repository */;
  body: string; ranges: BodyRange[]; quote?: Quote;
  attachments: Attachment[]; reactions: Reaction[]; edits?: number /* count */;
  editedAt?: number; deleted?: boolean; deletedBy?: string /* admin delete */; expiresAt?: number;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; // outgoing only
  kind: 'normal' | 'system'; systemText?: string; pinned?: boolean;
  failedRecipients?: string[]; nonce?: string /* client nonce, kept after ack */ }

interface Reaction { emoji: string; authorId: string; at: number }
interface Attachment { id: string; contentType: string; fileName?: string; size?: number;
  width?: number; height?: number; url?: string /* resolved blob:/data:/http url */; blurhash?: string }
```

Pure helpers (all unit-tested):
- `groupMessages(…)` → *flat* render items (`day-divider`, `new-divider`,
  `system`, `message` with `continuation`), carrying message ids; consecutive
  messages by one author within 7 minutes on the same day group.
- `parseMarkdownToRanges(text)` → `{ body, ranges }` converting `**b**`,
  `*i*`/`_i_`, `~~s~~`, `` `code` ``, `||spoiler||` into Signal body ranges
  (so formatting is **native** for recipients on official apps).
- `rangesToSegments(body, ranges)` → nested segment tree for rendering.
- `fuzzyScore(query, candidate)`.
- `colorForId(id)` → one of 12 theme-provided avatar hues.
- Also: `bodyToPlainText`, `attachMentions`, `applyReaction`, `applyEdit`,
  `applyDelete`, `advanceStatus`, `mergeDuplicate`, `summarizeReactions`,
  `escapeMarkdown`, `fuzzyMatch`/`fuzzyFilter`, `initialsFor`.

### 3.2 Backend contract (`core/backend/types.ts`)

Abridged; the file is authoritative.

```ts
interface ChatBackend {
  readonly kind: BackendKind           // string: a kind registered in app/backends.ts ('mock', 'signal-cli')
  connect(): Promise<void>; disconnect(): Promise<void>
  getStatus(): ConnectionStatus  // 'connecting' | 'online' | 'offline' | 'error'
  getSelf(): Promise<Contact>
  listContacts(): Promise<Contact[]>
  listConversations(): Promise<Conversation[]>
  send(input: SendInput): Promise<SendResult>                // { sentAt, attachments?, recipientFailures? }
  edit(input: EditInput): Promise<{ sentAt: number }>        // targets the original sentAt; re-sends the quote
  react(input: ReactInput): Promise<void>                    // add/remove
  deleteForEveryone(conv: ConversationId, sentAt: number): Promise<void>
  setTyping(conv: ConversationId, typing: boolean): Promise<void>
  markRead(conv: ConversationId, messages: MessageRef[]): Promise<void>   // MessageRef = { authorId, sentAt }
  // Optional; which ones exist is declared by each backend registration's `capabilities` (app/backends.ts)
  adminDelete?(conv: ConversationId, target: MessageRef): Promise<void>
  pinMessage?(input: PinInput): Promise<void>
  updateConversation?(conv: ConversationId, patch: ConversationPatch): Promise<void> // expireTimerSec | title | description
  fetchHistory?(conv: ConversationId, q: { before?: number; limit: number }): Promise<HistoryPage> // mock only
  resolveAttachmentUrl?(conv: ConversationId, attachment: Attachment): Promise<string>    // signal-cli: lazy blob: URLs
  acknowledge?(cursor: string): void                         // after a `checkpoint` has been persisted
  link?: { start(): Promise<{ uri: string }>; finish(uri: string, deviceName: string): Promise<{ accountId: string }> }
  on<E extends keyof BackendEvents>(event: E, fn: (p: BackendEvents[E]) => void): Unsubscribe
}
interface BackendEvents {
  status: ConnectionStatus
  message: Message                    // incoming or sync-sent
  messageEdited: { conversationId; authorId; targetSentAt; body; ranges; editedAt }
  messageDeleted: { conversationId; authorId; targetSentAt; deletedBy? }
  messagePinned: { conversationId; targetAuthorId; targetSentAt; pinned; by }
  reaction: { conversationId; targetAuthorId; targetSentAt; reaction: Reaction; remove: boolean }
  receipt: { authorId; sentAts: number[]; type: 'delivered' | 'read' | 'viewed' }
  typing: { conversationId; authorId; typing: boolean }
  readSync: { messages: MessageRef[] } // read on another linked device
  conversationUpdated: Conversation
  contactUpdated: Contact
  checkpoint: { cursor: string }      // resumable transports: everything before is complete
}
```
Adapters translate protocol quirks into these events. The UI never sees raw
envelopes. Transports are registered in the composition root
(`app/backends.ts`: kind, label, `load()`, capabilities, history store); how
to add one: `docs/ARCHITECTURE.md`. Message identity stays Signal's
`(authorId, sentAt)`; the plan for opaque ids is in ARCHITECTURE.md
("Future: opaque message ids").

### 3.3 Stores (`core/stores`, zustand/vanilla)

One slice per file, each exporting `createXStore()` and a typed selector set:
- `sessionStore` — backend kind, connection status, self contact.
- `contactsStore` — `Record<id, Contact>`.
- `conversationsStore` — `Record<id, Conversation>` (protocol state), derived
  ordering, unread & mention counts, read cursors (seqs), sidebar previews
  (`lastMessage`).
- `localStore` (persisted) — device-local conversation state (pin, mute,
  archive, draft), private contact notes, reaction usage (quick reactions).
- `messagesStore` — per-conversation windows `{ ids, byId, hasMoreBefore,
  hasMoreAfter, anchoredToPresent, loading, loaded }` (capped at 400),
  optimistic inserts keyed by client nonce.
- `typingStore` — ephemeral `Record<conv, Record<author, expiresAt>>`.
- `spacesStore` (persisted) — local organisation: spaces, categories,
  conversation → space/category assignment, order, collapsed state.
- `uiStore` — selected space & conversation, panel visibility, open modal,
  reply target, editing target, unread markers, scrolled-up flags, window
  focus, toast queue.
- `settingsStore` (persisted, versioned with migrations; v3) — `appearance`,
  `notifications`, `behaviour`, `connection`, `keybinds` overrides,
  `plugins` (enabled + settings), `customCss`, `customThemes`.

Services wire backend events → stores and actions → backend:
- `SyncService`: subscribes to backend events, persists messages to the
  repository, updates stores, computes unread/mentions.
- `SendService`: optimistic send with a persisted outbox, manual retry /
  discard of failed sends, markdown → ranges, plugin send transforms, queued
  edit/react/delete on pending messages, receipts that beat the ack
  (`ReceiptBuffer`).
- `HistoryService`: opens, pages and jumps conversation windows; backfills
  from `fetchHistory` when local history runs out.
- `NotificationService`: desktop notifications (Notification API) honouring
  mute / mention-only / focus state and plugin boosters.

The data flow (event queue, `seq` ordering, checkpoints, the send pipeline)
is described in `docs/ARCHITECTURE.md`.

### 3.4 Extension system (`core/plugins`) — the "Vencord" layer

We do **not** monkey-patch. The app exposes typed *extension points*; the
core features are themselves written against the same points where
reasonable (dogfooding keeps them honest).

```ts
definePlugin({
  id: 'clear-urls', name: 'Clear URLs', description: 'Strips tracking params from links you send.',
  authors: ['shrike'], tags: ['privacy'],
  settings: defineSettings({ extraParams: { type: 'string', label: 'Extra params', default: '' } }),
  start(ctx) {  // ctx: PluginContext — scoped, auto-disposed on stop
    ctx.send.addTransform((draft) => ({ ...draft, text: strip(draft.text, ctx.settings.get('extraParams')) }))
  },
})
```

The plugin author guide is `docs/PLUGINS.md`.

`PluginContext` capabilities (each returns a disposer, all tracked for stop):
- `ctx.commands.register({ id, title, keybind?, run })` — palette + hotkeys.
  `ctx.commands.execute(id)` runs any command (plugins drive the app by id).
- `ctx.keys.addLayer(layer)` — modal key layer with first refusal on keys (Vim mode; §8).
- `ctx.composer.addAccessory(id, Component)` — rendered inside the composer field
  (props `{ conversationId, descriptionId }`).
- `ctx.slash.register({ name, description, usage?, execute })` — `/shrug`, `/me`…;
  `execute` returns a `SlashResult` (`send` | `replace` | `error` | `done`).
- `ctx.send.addTransform(fn)` — outgoing draft pipeline; `ctx.send.addTypingGuard(fn)`.
- `ctx.messages.addAccessory(id, Component)` — rendered under a message (props `{ message }`).
- `ctx.messages.addDecoration(id, Component)` — badge next to author name (props `{ message }`).
- `ctx.messages.addHoverAction({ id, icon, label, onClick, visible? })`.
- `ctx.messages.reply(m)`, `react(m, emoji)`, `copy(m)` — act on a given message.
- `ctx.conversations.get(id)`, `isDirect(id)` — read-only lookups.
- `ctx.state(initial)` — plugin-local observable (`usePluginState` in `ui/hooks`).
- `ctx.menus.add('message' | 'conversation' | 'member' | 'space', item)`
  (no member menu renders plugin items yet).
- `ctx.headerBar.addButton(...)`, `ctx.settingsPanels.add(...)`.
- `ctx.styles.inject(css, id?)`.
- `ctx.notifications.addBooster(fn)` — a reason string makes a message notify like a mention.
- `ctx.stores` (read + subscribe), `ctx.backend` (`kind`, `status()`,
  `sendText()`, `onMessage((message, { live }) => …)`), `ctx.toast`,
  `ctx.log`, `ctx.onDispose`.
- `ctx.settings.get/set/all/subscribe` (typed from the schema).

Plugins that render UI supply React components; the runtime is React-agnostic
(components are typed by their props only, `ComponentLike<P> = (props: P) =>
unknown`, stored in registries; `ui/` renders them via
`<Slot name="message.accessories" …/>`). Each slot is wrapped in an error
boundary: a crashing plugin shows a small inline "plugin X failed" chip and
never takes down the app. Callbacks the UI invokes (hover actions, menu
items, header buttons) run through `Registries.invoke` / `isVisible`, so
their errors reach the plugin's card like command and transform errors.

Built-in plugins (as shipped; headless ones in `core/plugins/builtin`, UI ones
in `ui/plugins`):
1. **Clear URLs** — send transform (on by default).
2. **Slash Basics** — `/shrug`, `/tableflip`, `/unflip`, `/me`, `/spoiler` (on by default).
3. **Keyword Alerts** — notification booster, optional toast, highlight chip.
4. **Relative Timestamps** — "3m ago" decoration.
5. **Message Tools** — *Copy as Markdown* and word count (hover actions + menu item).
6. **Pronoun & Notes Badge** — first line of your private note on a contact, as a decoration.
7. **Vim Mode** — key layer + modal composer editing (off by default; see §8).

*Silent Typing* was retired in the P4 review: it is the Privacy setting
"Send typing indicators" (`behaviour.sendTypingIndicators`); typing guards
remain a plugin API.

### 3.5 Theming (`core/themes`, `ui/styles`)

- All colour/space/radius/shadow/motion values are CSS custom properties
  (`--shrike-*`) defined in `tokens.css` for the base (dark) theme.
- A theme = `{ id, name, description, kind: 'dark' | 'light', tokens:
  Partial<Record<TokenName,string>>, css?, preview }` applied to `:root` via
  `<style id="shrike-theme">`, followed by `#shrike-plugins` (plugin CSS) and
  `#shrike-custom-css`. Token reference and theme file format: `docs/THEMING.md`.
- Built-in: **Dusk (dark, default)**, **Midnight (OLED black)**, **Linen (light)**,
  **High Contrast**.
- Appearance settings: theme, accent colour (overrides `--shrike-accent*`,
  derived shades via OKLCH computations), message density (comfortable/compact),
  font scale (87.5–125%), UI zoom, show avatars in compact mode, 12/24h time.
  Accessibility: reduced motion, saturation, stronger focus outline, larger
  targets.
- **Custom CSS** (formerly "QuickCSS"; settings key `customCss`): live-editing
  editor (monospace, tab-indent) injected last.
- **Privacy:** user CSS and imported themes may not fetch anything. The
  sanitiser removes every statement/declaration referencing a non-inline
  resource (`@import`, `url(`, `image-set(`… decided on an unescaped,
  comment-free copy); theme tokens are allowlisted per kind (colour, length,
  number…); the production build ships a CSP (`default-src 'self'`,
  `img/media data: blob:`, `connect-src 'self'`). Imported themes with CSS
  apply on a 10 s "Keep this theme?" probation; **safe mode** (`?safe=1`, or
  Shift held while loading) skips imported themes and Custom CSS.
- `accent-text` is derived from the accent (OKLCH lightness shifted to ≥ 4.5:1
  on `bg-chat`) and used wherever the accent is a text colour.
- Stable styling hooks: every major region carries a `data-shrike="region-name"`
  attribute so user CSS/themes don't depend on hashed CSS-module class names.

## 4. UX specification (TOP PRIORITY)

### 4.1 Layout

```
┌────┬──────────────┬──────────────────────────────────────┬──────────────┐
│Rail│ Sidebar      │ Chat header (title · topic · actions)│              │
│72px│ 248px        ├──────────────────────────────────────┤ Member list  │
│    │ [search]     │                                      │ 248px        │
│ ⌂  │ PINNED       │   message list (virtualised)         │ (groups only;│
│ ── │ DIRECT MSGS  │                                      │ toggleable)  │
│ ▣  │ GROUPS       │                                      │              │
│ ▣  │              ├──────────────────────────────────────┤              │
│ +  │ [user panel] │ composer                             │              │
└────┴──────────────┴──────────────────────────────────────┴──────────────┘
```
Responsive: < 1100px hides member list (toggle overlays it as a sheet);
< 760px collapses rail+sidebar into a slide-over drawer (hamburger in header,
swipe/Escape to close). Min supported width 360px.

### 4.2 Spaces rail
- **Home** at top (Shrike glyph): all DMs + unassigned groups. Unread
  indicator = a 6px light pip (`--shrike-text-strong`) at the rail's left
  edge, level with the tile's centre and clear of the selection ring; mention
  count = red badge (`--shrike-danger-strong`) bottom-right.
  No left-edge pill: that is another product's trade dress.
- Separator, then **Spaces**: local, user-defined collections of Signal
  groups (and optionally DMs), shown as rounded-square tiles with emoji or
  initials, tinted with the space colour and filled with it on hover.
  Constant 14px radius (`--shrike-radius-tile`, no shape morph). Tooltip with
  name on hover (right side).
- Selected space: 2px `--shrike-accent` ring at a 3px offset from the tile.
  Accent is reserved for selection; keyboard focus is a dashed outline further
  out so the two never read alike.
- Drag to reorder; dropping a space on the middle of another tile creates (or
  joins) a **folder**. A collapsed folder is one tile with a 2×2 preview of its
  spaces; an open folder lists its tiles, grouped by a 2px bracket in the
  rail's right gutter (in the folder's hue, if set). Folder menu: mark read,
  expand/collapse, rename and recolour, dissolve.
- `+` tile → Create Space dialog (name, emoji/colour, pick groups with a
  searchable checklist; suggestions based on shared members).
- Right-click tile (or Shift+F10 / Ctrl+Enter): Mark all read, Mute space,
  Edit, Move up/down, Delete (confirm; groups return to Home).
- Bottom: connection health dot (only visible when not online).

### 4.3 Sidebar
- Header: space name + chevron (space menu) or "Home" with search button
  "Find or start a conversation" that opens the quick switcher.
- In Home: sections **Pinned**, **Direct Messages**, **Groups**, each
  collapsible, sorted by last activity. Rows: avatar (DMs) / group glyph,
  title, one-line preview (DMs only when hovered? → no: show a muted last-message
  preview for DMs and groups in Home; hidden in Spaces for a cleaner channel feel),
  unread = bold title + strong text and a flat-sided 4×12 tab
  (`border-radius: 0 2px 2px 0`, `--shrike-text-strong`) on the sidebar edge,
  mention badge, muted = 50% opacity, typing = animated dots replacing preview.
  Section labels are sentence case ("Direct Messages", "Archived · 3").
- In a Space: collapsible **categories** (user-created; default "Chats") with
  channel-style rows: `#` glyph, title, badges. Drag rows between categories.
- Row hover shows a `⋯` button (the row menu) on every row, plus an archive
  `×` in Home.
- Right-click row (or Shift+F10 / ContextMenu key / Ctrl+Enter on a focused
  row): Mark as read, Mute ▸ (15m/1h/8h/24h/until I turn it back on),
  Pin/Unpin, Move to space ▸, Move to category ▸ (in a space), Copy ID,
  plugin items, Archive. (*Disappearing messages ▸* is not offered yet: no
  service exposes `updateConversation`.)
- **User panel** at the bottom: avatar + profile name + "linked device"
  subtitle (or connection state in colour when degraded); buttons: toggle
  notifications (bell), settings (cog).

### 4.4 Chat header
Left: glyph + title (click → conversation details popover), divider, topic
(group description, truncated, click expands). Right: disappearing-timer
indicator (if set), pinned messages (popover), search (inline field that opens
results panel), toggle member list (groups), inbox (mentions across convos).

### 4.5 Message list
- Virtualised, anchored to bottom; prepend history without jumping.
- **Grouping:** consecutive messages by the same author within 7 minutes and
  same day collapse; continuation rows show time on hover in the gutter.
- **Day dividers** ("Tuesday, 29 September 2026") centred on a hairline.
- **New messages divider** (accent line, "NEW" tag) at the first unread on
  open; a top bar "N new messages since 14:02 · Mark as read" when the divider
  is off-screen.
- **Jump to present** pill appears when scrolled up > 1 screen; new messages
  while scrolled up increment a counter on that pill instead of auto-scrolling.
- **Message anatomy (comfortable):** 40px avatar, author name (contact colour) +
  decorations + timestamp (hover: full date tooltip), body with native
  formatting & mentions (mention of self = accent-tinted row background +
  left accent bar), "(edited)" tag with tooltip, attachments (image grid ≤4,
  click → lightbox; files as cards with icon, name, size, download),
  reactions row (pills with emoji + count; own reactions accent-outlined;
  hover shows who reacted; click toggles), plugin accessories.
- **Reply/quote:** thin curved connector + mini avatar + author + one-line
  snippet above the body; click jumps & flashes the original.
- **Hover action bar** (top-right, floating): quick reactions (3 most-used),
  add reaction, reply, edit (own), more (…) → menu. Holding Shift reveals
  destructive quick actions (delete) without menu.
- **States:** pending (60% opacity), failed (red "Failed to send · Retry ·
  Delete"), deleted ("This message was deleted." italic muted), disappearing
  (small timer icon + countdown tooltip).
- **Compact mode:** single-line `[time] Author: body`, no avatars (setting).
- **System messages** (member joined, title changed, timer changed): icon +
  muted text, one line.
- **Empty conversation:** friendly header block: large avatar, title, "This
  is the beginning of your conversation with X", safety-number hint.
- Loading history: skeleton rows (shimmer disabled under reduced motion).

### 4.6 Composer
- Rounded field, auto-grows to 50% of viewport then scrolls.
- Left `+` button: upload file. Drag-and-drop anywhere over the chat shows a
  full-panel drop overlay ("Drop to send to #title"). Paste images.
- Attachment tray above the input with thumbnails and remove × (no spoiler
  toggle: `OutgoingAttachment` has no spoiler flag).
- Right: emoji picker button.
- Markdown shortcuts (live preview is out of scope; formatting is shown after
  sending); Ctrl+B / Ctrl+I / Ctrl+Shift+X wrap selection.
- Autocomplete popover above composer for `@member`, `:emoji`, and `/command`
  — arrow keys + Tab/Enter to accept, Escape to dismiss.
- Reply bar: "Replying to **Name**" + ×; Escape cancels.
- Edit mode: `Up` in empty composer edits your last message inline
  (in-place editor in the message row, "escape to cancel · enter to save").
- Enter sends, Shift+Enter newline (setting to swap).
- Typing indicator strip below composer: "Alex is typing…", "Alex and Sam are
  typing…", "Several people are typing…".
- Draft persistence per conversation.
- Placeholder: "Message #group-name" / "Message @Name".

### 4.7 Member list (groups)
- Sections in sentence case: **Admins · N**, **Members · N**. Rows: avatar,
  name (contact colour mixed toward text for legibility), about-emoji. No fake
  presence. Below 1100px the list is a modal sheet from the right (focus
  trapped, Esc closes, focus returns to the toggle).
- Click → **profile popout** anchored to the row: a header tinted with the
  contact colour holding a 48px avatar *left of* the name (no banner with an
  overlapping avatar ring), profile name, "Group admin" chip where relevant;
  then about, number (formatted, if shared), "Message" (always enabled: opens
  or creates the DM), "Copy safety-number steps" (verification itself happens
  on the phone), and a private note ("Add a private note…", local, persisted).

### 4.8 Quick switcher (Ctrl/Cmd+K)
Modal with fuzzy search over conversations, spaces and commands (prefix `>`
for commands, `@` DMs only, `#` groups only, `*` spaces only; the prefix
becomes a chip). Empty query shows unread (mentions first) then recent.
Result rows show kind icon and space name. Enter opens; no Shift+Enter
variant.

### 4.9 Settings (full-screen overlay, Escape to close)
Left nav grouped: **You** (My profile, Privacy), **General** (Appearance,
Accessibility, Notifications, Keybinds, Behaviour), **Customise** (Plugins,
Themes, Custom CSS), **System** (Connection, Data & storage — export/clear
local history, About/licences), then **From plugins** (plugin settings
panels). "← Back to chats" sits atop the nav (no round
close button). Changes apply live; no Save button. Search box filters
settings entries (plugins and command shortcuts included).
- **Plugins page:** grid of cards (name, description, tags, toggle, cog →
  auto-generated settings form from schema). Search + filter (enabled /
  disabled / tag). Restart-free enable/disable.
- **Appearance page:** theme cards with live mini-previews, accent presets +
  custom colour with contrast warnings, density, text size, zoom, 12/24h.
- **Themes page:** the same theme cards with export / remove, and import of
  theme files (validated; themes with CSS apply on a 10 s probation).
- **Custom CSS page:** code editor, live apply, list of stable hooks.

### 4.10 Onboarding / connection
First run: welcome screen with two choices: **Try the demo** (mock backend,
seeded world) or **Connect to signal-cli** (daemon URL, default `/signal-cli`:
the same-origin dev/preview proxy to `SHRIKE_SIGNAL_CLI_URL`, default
`http://127.0.0.1:8080`; the form probes the daemon first). A single-account
daemon asks for the account number once. If the daemon has no account: **Link
this device** flow — QR code from `startLink`, explains "Signal app → Settings
→ Linked devices → +", waits on `finishLink`, then syncs. Connection problems
surface as a slim banner at the top of the chat column, with retry.

### 4.11 Keyboard map (defaults, rebindable)
| Action | Keys |
|---|---|
| Quick switcher | Ctrl/Cmd+K |
| Prev/next conversation | Alt+↑ / Alt+↓ |
| Prev/next unread | Alt+Shift+↑ / ↓ |
| Mark conversation read | Escape (when composer empty) |
| Focus composer | any printable key when nothing focused |
| Edit last message | ↑ in empty composer |
| Toggle member list | Ctrl+Shift+M |
| Settings | Ctrl+, |
| Search in conversation | Ctrl+F |
| Jump to present | Shift+PageDown |
| Keyboard shortcut help | Ctrl+/ |

The complete keyboard reference (lists, composer, dialogs, Vim mode) is
`docs/KEYBOARD.md`.

### 4.12 Accessibility & motion
- All interactive elements reachable by keyboard; visible focus ring
  (`:focus-visible`, 2px accent outline, offset 2px).
- Message list rows form a `role="feed"` of `role="article"` rows with one
  roving tab stop; new arrivals are announced by a throttled polite live region
  (`LiveAnnouncer`).
- Colour contrast ≥ 4.5:1 for text in all built-in themes.
- Motion 120–200ms `cubic-bezier(.2,.8,.2,1)`; everything disabled when
  reduced motion (OS or setting).
- Hit targets ≥ 32px in rail/sidebar.

### 4.13 Visual language
- Logo: `ShrikeMark` / `public/shrike.svg`, a shrike's head in profile built
  from straight cuts, with a short hooked beak and a bold mask stripe through
  the eye. In the app it is one colour (currentColor, mask knocked out); the
  favicon puts a pale head and black mask on a rufous tile. Reads at 16px.
- Default theme **Dusk**: graphite neutrals (cool grey, like the bird's
  plumage): rail `#101114`, sidebar `#15171b`, chat `#1b1d22`, elevated
  `#22252b`, floating `#0c0d10`, border `rgba(255,255,255,.06)`, text
  `#e6e8eb`, muted `#aaadb2`, faint `#9b9ea4`. Accent rufous `#d4744a`
  (hover `#e58359`, active `#c06238`, dark `#1a0f0b` text on it), danger
  `#f26781` (badge/button fills use `danger-strong` `#c93553` so white text
  passes 4.5:1), success `#3ccf91`, warning `#f5b44a`, mention bg
  `rgba(212,116,74,.10)`. Linen uses a deeper rufous `#a84f2c` (white text on
  it), High Contrast a lighter `#ef8d62`.
- 12 avatar hues; white initials ≥ 4.5:1 on each (tested, all themes).
- All text tokens ≥ 4.5:1 on every surface in every built-in theme
  (`src/test/contrast.test.ts`).
- Type: Inter; message 15px/1.375, UI 14px, headers 16px 600,
  section labels 12px 600 sentence case (no uppercase tracking).
- Radii: 4 / 8 / 12 / 16; rail tiles a constant 14.
- Shadows only on floating layers (menus, popouts, modals).

## 5. Mock backend world
Seeded, deterministic (seeded PRNG), ~25 contacts, ~12 groups, ~10 DMs,
realistic multi-day histories including replies, reactions, edits,
deletions, attachments (generated SVG/data-URL images), mentions, formatting,
long messages, code. A "liveliness" simulator emits typing + messages +
reactions every few seconds in a couple of conversations (toggle:
Settings → Connection → Simulated activity). Default spaces pre-created on first demo run ("Work",
"Climbing Club", "Family") so the Discord-like structure is visible
immediately.

## 6. Delivery phases

Each phase: **builder** implements → **reviewer** audits (code quality +
UX against §4 + plan conformance) → builder fixes → orchestrator verifies
gates and commits. Quality gates for every phase:
`npm run typecheck && npm run lint && npm test && npm run build` all green.

| Phase | Scope | Acceptance | Status |
|---|---|---|---|
| **P1 Foundation** | Scaffold, tooling, lint boundaries, tokens/themes base, domain types + pure helpers (with tests), backend contract, mock backend + seed world, IndexedDB repository, stores, services (sync/send), plugin runtime + registries (headless), command registry | Headless tests cover grouping, markdown→ranges, segments, fuzzy, stores, plugin lifecycle, mock backend events | **Done** (4d3528c), review fixes f983ffa + de40998. Added beyond scope: `core/lib`, `HistoryService`, `seq` ordering, outbox, `localStore`. |
| **P2 Shell** | App bootstrap, primitives, rail, sidebar, chat header, user panel, member list, profile popout, responsive layout, onboarding (demo path) | App boots into demo with seeded spaces; navigation works end-to-end by keyboard and mouse | **Done** (de40998, review fixes included). |
| **P3 Messaging** | Message list, message rendering, reactions, replies, attachments + lightbox, hover bar, context menu, composer with autocomplete/attachments/edit/reply, typing, unread divider, jump-to-present | Send/edit/react/reply/delete all work optimistically against mock | **Done** (f16f3b4, review fixes included). Not done: attachment spoiler toggle (no protocol flag), scroll restore per conversation, search term highlighting. |
| **P4 Power UX** | Quick switcher, settings overlay (all pages), plugins UI + built-in plugins, themes + accent + Custom CSS, keybinds, spaces CRUD + drag & drop, notifications | All built-in plugins toggle live; theme changes live | **Done** (20e5a11; review fixes in 1105001). Also: device linking, `deferredBackend`, licence list, safe mode, CSP. Then **Vim mode** + key-layer API (1105001). |
| **P5 signal-cli** | Adapter (JSON-RPC HTTP + SSE with Last-Event-ID resume), envelope normaliser (tested with fixtures), attachments, link-device flow, Vite proxy, README setup guide | Fixture-driven tests; manual run doc | **Done** (de40998, review fixes cf9126c); setup guide is `docs/SIGNAL_CLI.md`. Verified against fixtures and a fake daemon only (see §8 "Known limits"). |
| **P6 Polish** | Visual QA via Playwright screenshots of every surface in 3 themes & 3 widths, a11y audit (axe), perf (10k-message conversation smooth), docs (ARCHITECTURE.md, PLUGINS.md, THEMING.md) | Reviewer sign-off | **In progress.** Docs written: `README.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/THEMING.md`, `docs/KEYBOARD.md` (checked against code). Visual QA, axe audit and the 10k-message perf pass await sign-off. Final-review polish: builder A (UX/a11y), builder B (code quality, extensibility; §8 "P6 polish B"). |

## 7. Code conventions
- Named exports only; one component per file; file = component name.
- Components ≤ ~200 lines; extract hooks (`useX`) for logic.
- No `any`; `unknown` + narrowing at boundaries (adapters validate input).
- Store access in components via selector hooks only (no whole-store subscriptions).
- CSS Modules: `Component.module.css` next to component; only tokens, never
  raw hex outside `tokens.css`/theme files.
- Tests colocated as `*.test.ts(x)`.
- Comments explain *why*, not *what*.

## 8. Implementation notes & deviations

Recorded by the builder of each phase. Where these refine §3, they win.

Renamed from Hearth on 2026-09-30 due to a name collision.

### P1 Foundation

**Structure**
- New leaf module `core/lib` (Emitter with listener-error isolation,
  `Clock`/`Scheduler` + `ManualScheduler` for tests, `DisposableStore`,
  `ObservableList` with stable snapshots for `useSyncExternalStore`, nonces).
  Same boundary rule as `core/domain`.
- `core/services` gained `HistoryService` (paging) next to Sync/Send.
  `NotificationService` is deferred to P4.

**Domain (§3.1)**
- `Message.nonce?` — client nonce of outgoing messages; kept after
  acknowledgement (in memory and storage) so render keys stay stable across
  the `pending:<nonce>` → `author:sentAt` id swap.
- `Contact.color` holds `var(--shrike-avatar-N)` (a slot, not a colour) so each
  theme can retune hues.
- `groupMessages` returns *flat* render items (`day-divider`, `new-divider`,
  `system`, `message` with `continuation: boolean`) because the virtualised list
  renders one row per item. Items carry message **ids**, not messages (rows
  subscribe per id). Replies and negative (clock-skew) gaps start a new group.
- Extra pure helpers: `bodyToPlainText`, `attachMentions`, `applyReaction`
  (one reaction per author, Signal semantics), `advanceStatus` (receipts never
  downgrade), `applyEdit`, `applyDelete`, `summarizeReactions`, `escapeMarkdown`,
  `fuzzyMatch`/`fuzzyFilter` (with highlight indices), `initialsFor`.
- Markdown: a linear CommonMark delimiter-run algorithm (left/right flanking,
  rule of 3, `openersBottom`). Chat deviations: no `__bold__` (so `__init__.py`
  survives), `~~`/`||` must be exactly two and never intraword, http(s) URLs are
  atomic like code spans, a fenced block's first line is dropped only if it is a
  known language id. Mentions: the composer puts U+FFFC in the text and passes
  ids in order; ids are re-attached *after* parsing.

**Backend contract (§3.2)**
- `send()` may return resolved `attachments`.
- New event `readSync { messages: {authorId, sentAt}[] }` (read on another linked
  device; Signal gives no conversation id, the sync engine resolves it).
- Optional `fetchHistory?(conv, { before?: sentAt, limit })` → `{ messages, hasMoreBefore,
  readUpTo? }`. Only the mock implements it; signal-cli has no history. The
  repository is the source of truth: `SyncService` seeds the newest page on first
  sight, `HistoryService` backfills older pages from the backend when local
  history runs out. `readUpTo` seeds read cursors on first sync; otherwise a
  first-seen conversation starts fully read (no stale badge flood).
- Status events are applied immediately; all other events go through one ordered
  queue so e.g. an edit can't overtake its message.

**Persistence**
- `MessageRepository` also stores per-conversation read cursors, the outbox,
  and answers search / mentions / expired queries (see "Review round 1").
- The demo (mock) uses the in-memory repository: its world is regenerated each
  launch relative to "now", so persisting it would mix timelines. Mock identities
  (contact/conversation ids) come from a separate PRNG stream and are stable
  across launches, so persisted Spaces keep working. `IdbMessageRepository` is
  ready for P5.
- Settings/spaces persist via `loadVersioned/saveVersioned` (`{ v, data }`,
  step-wise migrations, per-field validation, corrupt data → defaults).

**Stores (§3.3)**
- Settings sections: `appearance`, `notifications`, `behaviour` (incl.
  `markdown`, `linkPreviews: false` default), `connection` (backend choice,
  daemon URL, mock liveliness), `keybinds`, `plugins`, `quickCss`.
  `plugins[id].enabled` is optional: absent ⇒ the plugin's `enabledByDefault`.
- Spaces model: spaces with ≥1 category, a `rail` of spaces **and folders**,
  collapsed Home sections, and a `seeded` flag so deleted default spaces never
  come back (seeded for the mock backend only). Assignments are never
  auto-pruned; unknown conversations are hidden via
  `spacesSelectors.visibleConversationIds`. The parser restores invariants
  (dedupes conversations/categories/rail entries). `HOME = 'home'` is the
  pseudo space id in `uiStore`.
- `uiStore` also holds a capped toast queue (`pushToast` / `dismissToast`),
  used by `ctx.toast`.

**Plugins (§3.4)**
- Extra capabilities: `ctx.send.addTypingGuard` (Silent Typing),
  `ctx.onDispose`, `ctx.backend = { kind, status(), sendText(), onMessage() }`
  (`onMessage` fires after a message is stored). Definition flags `required`
  (can't be disabled) and `preview` (UI lands later).
- Slash commands return `SlashResult` (`send` | `replace` | `error` | `done`);
  `parseSlash()` parses composer text.
- `Registries` implements the send pipeline (`DraftPipeline`): transforms run in
  order and a throwing transform is skipped, never blocking the send.
- Built-ins: Clear URLs ✔, Silent Typing ✔, Slash Basics ✔ (`/shrug`,
  `/tableflip`, `/unflip`, `/me`, `/spoiler`), Keyword Alerts (toast ✔,
  highlight → P4), Relative Timestamps (preview → P4), "Message Tools" = Copy as
  Markdown + word count (preview → P4).

**Commands / themes**
- Keybinds are stored as portable strings with `Mod` (Cmd on macOS, Ctrl
  elsewhere); matching falls back to `event.code` for layout-shifted keys.
  Core command ids + §4.11 defaults live in `core/commands/defaults.ts`.
- `tokens.css` adds layout, font-scale, zoom and saturation tokens; a test keeps
  it in sync with `core/themes/tokens.ts`. The theme engine sets
  `data-theme`, `data-theme-kind`, `data-density`, `data-reduced-motion`,
  `data-saturation-adjusted` on `<html>` and keeps its three `<style>` tags last
  in `<head>`. Linen uses a deeper accent for contrast on paper (now rufous `#a84f2c`).

**Tooling**
- Current majors at time of writing: TypeScript 6, Vite 8, Vitest 5, ESLint 10.
  ESLint type-aware linting uses explicit `tsconfig.app.json`/`tsconfig.node.json`
  projects (the solution-style root hid `noUncheckedIndexedAccess`).

### P1 review round 1

**Ordering & identity (M6).** `(authorId, sentAt)` is identity only. Every
stored message gets `seq`, a local monotonic arrival sequence assigned by the
repository (`upsert`; backfilled history gets seqs *below* everything stored;
optimistic sends reserve one with `allocateSeq()` so they keep their place).
Timeline order, the repository index (`[conversationId, seq]`), read cursors,
unread counting, the "new messages" divider and conversation activity
(`receivedAt`) all use local arrival, so a sender with a skewed clock can't
bury a new message.

**Conversation model (M4).** `Conversation` is protocol-only
(`id, kind, title, description?, avatarUrl?, memberIds, adminIds,
expireTimerSec, lastActivityAt`). `pinned / muted / archived / draft` moved to
`LocalConversationState` in the persisted `localStore` (with contact notes);
`ConversationView = Conversation & LocalConversationState` is derived by
memoised selectors (`stores/views.ts`). `ConversationPatch` no longer includes
`muted`. Drafts persist (debounced writes, flushed on `pagehide`).

**Backend contract additions (minor 12).**
- `Quote.ranges?` (styles + mentions of the quoted text).
- `send()` → `SendResult { sentAt, attachments?, recipientFailures? }`;
  adapters throw if nobody received it; partial group failures set
  `Message.failedRecipients`.
- `pinMessage?(PinInput)` + event `messagePinned`; `adminDelete?(conv, ref)` +
  `messageDeleted.deletedBy?` → `Message.deletedBy`.
- `markRead` / `readSync` use `MessageRef { authorId, sentAt }`.

**Repository.** `upsert(message, merge)` (get-then-merge in one transaction;
`mergeDuplicate` keeps later edits/reactions/deletion/seq and only advances
status), `upsertMany(…, { backfill })`, `page({ before | after: seq })`,
`latest`, `allocateSeq`, `search(text, { conversationId?, limit })` (linear
scan for now), `mentions(contactId)` (multiEntry index), `expired(now)`
(`expiresAt` index), outbox (`putOutbox/listOutbox/deleteOutbox`).

**Sync (M3, M8, minors 1/2/11/12).** The event queue is gated on the initial
sync, so envelopes delivered while loading are processed afterwards against
real cursors (first-seen conversations treat only *pre-session* history as
read). `start()`/`stop()` are idempotent and restartable; a failed start tears
down its subscriptions and drops anything queued. Duplicate deliveries don't
re-count or re-notify; stale edits (`editedAt` ≤ current) are ignored; unknown
DM senders get a synthesised conversation; conversation refreshes coalesce with
one follow-up; expired messages are purged on a timer.

**Send (B1, M5, minors 3/9/10).** Sends persist a `pending:<nonce>` row and an
outbox entry (restored as *failed* after a reload). Edit/react/delete on a
pending message are shown immediately and queued, then replayed against the
real id after acknowledgement; on a failed (never sent) message an edit rewrites
the outgoing input and a delete discards it. `lastOwn` excludes pending/failed.
Receipts that arrive before the send is acknowledged are held in a shared
`ReceiptBuffer` (60 s TTL) and applied on reconcile; reconcile merges instead of
overwriting. `OutgoingDraft.format?: 'markdown' | 'plain'` (slash results carry
`format`); plugin transforms whose output isn't a valid draft for the same
conversation are skipped.

**Windows (M7).** `ConversationWindow = { ids, byId, hasMoreBefore,
hasMoreAfter, anchoredToPresent, loading, loaded }`, capped (400 by default)
with eviction on the far side. `HistoryService`: `open` (snapshots the unread
marker into `uiStore.unreadMarkers`), `ensureLoaded`, `loadOlder`, `loadNewer`,
`jumpTo(messageId)`, `jumpToPresent`. Live messages append only to windows
anchored to the present (the UI jumps to present before sending). In-place
updates keep `ids` identity; `createRenderItemsSelector` recomputes layout only
when ids/marker change.

**Other.** Keybinds use `event.code` only when `event.key` isn't printable
ASCII (non-QWERTY layouts). Fuzzy matching is an O(q·c) DP. The plugin runtime
reconciles only on enable-flag changes. `loadVersioned` backs up unusable data
to `<key>.backup` before defaults take over.

### P5 signal-cli

**Modules** (`core/backend/signal-cli/`): `validate` (tiny decoder combinators;
no dependency — we need *lenient* optional sub-objects: a bad `quote` is
dropped with a debug note instead of failing the message), `wire` (decoders
mirroring signal-cli's `Json*` records, types inferred from them), `rpc`
(JSON-RPC client, typed `SignalCliError` kinds incl. `unregistered`,
`untrusted-identity`, `rate-limited`, `send-failed` with per-recipient
failures), `sse` (incremental WHATWG parser + `EventStream` over `fetch`:
Last-Event-ID on first connect, equal-jitter exponential backoff, `retry:`,
45 s idle watchdog vs. the daemon's 15 s keep-alives, fatal 4xx), `normalise/*`
(pure envelope → events), `params` (send/quote/style/mention params, result
mapping), `attachments`, `peers`, `SignalCliBackend`. Fixtures in
`fixtures/envelopes.ts` are hand-written from the Java records; `testing.ts`
is a fake daemon (RPC + controllable SSE).

**Contract (backward-compatible).** New optional
`ChatBackend.resolveAttachmentUrl?(conv, attachment)`: signal-cli only exposes
attachment bytes via `getAttachment` (base64), so incoming attachments carry no
`url`; the UI calls this when an attachment is rendered and gets a cached
`blob:` URL (LRU of 200, revoked on disconnect; > 100 MB refused). Our own sent
attachments keep a plain `data:` URL when ≤ 1.5 MB (persisted), since nothing
echoes them back. The mock is unchanged (its attachments have URLs).

**Identity.** Everyone is identified by ACI when known, else number. Every
alias of our account (ACI, number) is mapped to one `selfId` (ACI) — sync
transcripts, reaction targets and quotes addressed by number still resolve to
us. Outgoing params pass ids through (signal-cli accepts ACIs everywhere).

**Normalisation decisions.** Incoming → `status: 'read'`, sync transcripts →
our own `'sent'` messages. Edits → `messageEdited` (`editedAt` = the edit's
timestamp). Admin delete → `messageDeleted { authorId: target, deletedBy }`.
Unsupported content (sticker, view-once, payment, shared contact, poll) becomes
an italic note in the body; poll votes, calls and stories are ignored with a
debug log. Disappearing timer: `expiresAt = receivedAt + timer` (Signal starts
it on read, so we err on deleting early). Timer updates → system line +
conversation patch. Group updates (`groupInfo.type = UPDATE`) → the backend
re-lists the group, diffs (name, description, timer, joined/left, new
admins) and emits `conversationUpdated` + one system line (same
`(author, sentAt)` id as the update). Typing older than 15 s (by server
timestamp) is dropped, because the daemon replays up to 1000 buffered events
on reconnect. Adapter events are applied through one queue so a group refresh
can't be overtaken by the next message.

**Conversations.** Groups come from `listGroups` (members only). signal-cli has
no DM list, so `DirectPeers` (localStorage, per account) remembers peers we've
exchanged messages with; a new peer emits `conversationUpdated` before its
first message. Contacts come from `listContacts { allRecipients: true }` so
group members get names (nickname → contact name → profile name → number). DM
disappearing timers come from the contact record; `updateConversation` uses
`updateContact --expiration` for DMs and `updateGroup` for groups.

**Connection.** `connect`: `/check` → `listAccounts` → preferred account
(settings) or the first → directory → stream (`?account=`). No account ⇒
`SignalCliError('no-account')` (onboarding shows the link flow).
`link.start/finish` use `startLink`/`finishLink` without an account param
(multi-account daemon). Status: stream open ⇒ online; first retry ⇒
connecting; ≥ 3rd retry ⇒ offline; refused stream ⇒ error. The last event id
is persisted per account so a page reload resumes the stream.

**Settings v2.** `connection.account: string | null` (migration adds it).
`connection.daemonUrl` is the *browser-side* base URL, default `/signal-cli`:
the daemon sends no CORS headers and pins the Host header, so the browser goes
through the Vite dev/preview proxy (`changeOrigin`, no timeouts; target
`SHRIKE_SIGNAL_CLI_URL`, default `http://127.0.0.1:8080`). The v1 default
`http://127.0.0.1:8080` is migrated to `/signal-cli`; custom values are kept.

**Composition root.** `createShrike` picks the backend from
`settings.connection.backend` once per instance (switching = new instance).
signal-cli uses IndexedDB (`shrike-signal-cli`) through `deferredRepository`
(a proxy that awaits `IdbMessageRepository.open()`, keeping `createShrike`
synchronous); falls back to memory without IndexedDB. `onAccountSelected`
writes the account into settings. Demo seeding/liveliness only for the mock.

**Known limits / not verified against a real daemon.** All tests use fixtures
and a fake daemon. Unverified: exact `send`/`sendReaction` param coercion for
arrays (`recipient`, `textStyle`, `mention`, `targetTimestamp`), `updateContact`
result shape, mention placeholder handling in bodies from official clients,
attachment ids for not-yet-downloaded files, behaviour of numberless accounts.
Several accounts on one daemon share the `shrike-signal-cli` database. Avatars
(`getAvatar`) are not fetched yet.

### P5 review round 1

**Contract (all optional / backward-compatible).**
- `BackendEvents.checkpoint { cursor }` + `ChatBackend.acknowledge?(cursor)`:
  the adapter emits a checkpoint after each SSE event's work; `SyncService`
  queues it like any event (so also behind the initial-sync gate) and
  acknowledges after the preceding repository writes. Only then is the
  `Last-Event-ID` persisted, so a reload re-delivers instead of losing.
  Events dropped by `stop()` are never acknowledged.
- `EditInput.quote?` — signal-cli rebuilds the edit's whole data message from
  params, so the original quote is re-sent (the adapter also remembers quotes of
  messages sent this session). **SendService should pass the original's quote**
  (not done yet: SendService belongs to P1/P2 owners).
- `Quote.attachments?: { contentType, fileName? }[]` — filled for incoming
  quotes; sent as `quoteAttachment`. **The UI should copy the quoted message's
  attachment types into its outgoing quote.**
- `resolveAttachmentUrl` JSDoc: URLs only for `<img>/<video>/<audio>` or
  `<a download>`, never navigation/frames.

**Adapter.** Single-account daemons (`listAccounts` → METHOD_NOT_FOUND): no
`account` param, no `?account=`, identity from `settings.connection.account`
(else `SignalCliError('account-required')`); `SelfIdentity` learns the other
identifier from the payload `account` field, envelope number/uuid pairs and
contact records. Connect opens the stream first, awaits only `listGroups`, and
loads contacts in the background (180 s timeout, shared in-flight request,
failure keeps the cache); directory TTL 10 min, refreshed on contacts sync, a
stranger's message (debounced) and messages for unknown groups. A fatally
failed stream clears itself so `connect()` can retry. Group updates: the
"before" snapshot is taken on arrival; runs of queued updates to one group are
diffed once, on the last, phrased passively when several people were involved.
Own `updateGroup`/`updateContact` changes write local system lines.
Attachments: blobs are typed only with allow-listed raster image/audio/video
types (else `application/octet-stream`); sent images keep a ≤ 512 px WebP/JPEG
thumbnail instead of the file; empty and > 100 MB files are rejected before
encoding. Undecryptable envelopes become a system line. Typing staleness and
disappearing timers use the server receive time.

**SyncService.** Tombstones for purged disappearing messages (in memory,
bounded to 2000) and a drop of messages already past `expiresAt` on arrival,
so a replay can't resurrect them.

**Dev server.** `devserver/signalCliGuard.ts` (plugin middleware, runs before
the proxy): loopback Host only; `Sec-Fetch-Site` same-origin/none; `Origin`,
when present, must be the app's origin. `server.cors` / `preview.cors` = false.


### P2 Shell

**Structure**
- `ui/hooks` holds the React-side context: `AppServices` (the structural
  subset of `Shrike` features need), `useShrike/useStores`, `ShellLayout`
  (narrow/drawer/nav state), `useObservableList`, `useMediaQuery`,
  `useRovingFocus`, `useKeybindLabel`, `useNow`. `app/ShrikeProvider` provides
  both the full `Shrike` (for app/) and `AppServices` (for ui/), so features
  never import the composition root.
- Extra feature folders: `conversation` (avatar look, row/preview helpers,
  shared conversation menu + actions), `shell` (layout, keyboard, commands,
  modal host, toast bridge, interim settings/shortcuts dialogs).
- Primitives added beyond §3: `Drawer` (left slide-over, swipe/Esc/scrim),
  `ShrikeMark` (logo glyph, same drawing as `public/shrike.svg`),
  `TypingDots`, `VisuallyHidden`. Menus take a declarative `MenuEntry[]`
  (built lazily when opened) rendered by both `ContextMenu` and `DropdownMenu`;
  `tidyMenu` drops stray separators. Wrappers pass extra trigger props through
  so `Tooltip`/`ContextMenu`/`DropdownMenu`/`Popover` compose via `asChild`.
- New deps: Radix tooltip/popover/context-menu/dropdown-menu/dialog/switch/slot,
  lucide-react, sonner, @dnd-kit core/sortable/utilities/modifiers; dev:
  @testing-library react/dom/user-event. `@floating-ui/react` and `cmdk` are
  not needed yet (P3 composer autocomplete / P4 palette).

**Core changes (minimal)**
- `conversationsStore.lastMessage` + `noteLatest(message)` for sidebar
  previews: newest by seq, or the same message (id or nonce) in a newer state.
  Fed by `SyncService` (seed, incoming, edits/deletes via `updateMessage`) and
  `SendService` (optimistic + reconcile). Known gap: discarding a failed send
  leaves the preview on it until the next message.
- `spacesStore.updateSpace({ emoji: '' })` clears the emoji.
- Tokens `text-on-avatar` and `text-on-danger` (white in every theme).
- Tooling bug fixed: `scripts/verify-boundaries.mjs` overwrote and then
  deleted the real `ui/features/sidebar/index.ts` (a fixture path); it now
  backs up and restores pre-existing files.

**Behaviour decisions**
- Onboarding: `settings.connection.backend === null` shows the welcome
  screen. "Try the demo" sets `mock` and starts the running instance. The
  signal-cli form saves `backend`/`daemonUrl` and, because `createShrike` picks
  the transport once, `main.tsx` reloads into a fresh instance
  (`App.onBackendChange`). Device linking (`no-account`) is still P4/P5.
- Opening a conversation calls `HistoryService.open` and marks it read while
  the window is focused (`useConversationLifecycle`); P3's list should narrow
  this to "read when scrolled to the bottom". Window focus/visibility is
  mirrored into `uiStore.windowFocused`.
- Navigation commands (`core.prev/nextConversation`, `core.prev/nextUnread`)
  are registered by the shell (`useCoreCommands`) because they need view
  order. Alt+↑/↓ walks the *rendered* sidebar rows; Alt+Shift+↑/↓ walks Home
  then every space in rail order (wrapping, switching space) and stops at
  conversations that are unread and not muted (conversation or space), or that
  mention you. One global keydown listener feeds `KeybindDispatcher`; it skips
  events already `defaultPrevented` (Radix layers handle their own Escape) and
  Escape while a modal is open.
- Collapsed sections/categories still show the open conversation and unread
  rows. Home lists archived conversations in a collapsible "Archived — N"
  section (local state, collapsed by default). Row hover: × archives (Home),
  cog opens the same menu as right-click (spaces).
- Conversation menu: Mark as read, Mute ▸ (15m/1h/8h/24h/forever) or Unmute,
  Pin/Unpin, Move to space ▸ (check = current space; Remove from space; New
  space…), Copy ID, plugin items, Archive/Unarchive. *Disappearing messages ▸*
  is not offered: the UI has no service call for `updateConversation` yet (P3/P4).
- Space menu: Mark all as read, Mute space, Edit, Move up/down (keyboard
  reordering, since dnd-kit is wired pointer-only so Enter/Space still
  activate tiles and roving tabindex survives), plugin items, Delete (confirm
  dialog; conversations return to Home, view falls back to Home).
- Rail: tiles are tinted with their hue at 18% and fill fully on hover/select
  (16px → 12px radius). Edge bar in accent: 8px unread → 20px hover → 40px
  selected. Mention badge bottom-right. The add tile is a dashed outline.
  Folders render collapsed as a 2×2 preview and expanded on a tinted segment;
  creating folders by drag is P4.
- Member list below 1100px is an overlay sheet with a scrim; crossing into the
  narrow layout closes it and restores the wide preference on the way back.
  Below 760px the rail + sidebar live in a `Drawer` that opens by default when
  nothing is selected and closes on selection.
- Header: title opens a details popover; topic click expands in place;
  disappearing-timer chip; plugin `headerButtons` (each in a `PluginBoundary`);
  member toggle (groups). Pinned/search/inbox buttons wait for P3 data.
- Interim modals: a small fuzzy quick switcher (conversations only; P4 replaces
  with cmdk), a Settings dialog with the theme picker and demo activity toggle
  (P4 replaces with the full overlay), and a keyboard-shortcut sheet (Ctrl+/).
- Create/Edit space covers name, icon (12 emoji or initials) and colour; the
  group checklist with suggestions is P4.
- The message area is a frame: `role="log"` region with the conversation's
  opening block and a note; the composer is a disabled shell with a live typing
  strip of reserved height. P3 mounts the list and editor inside these.

### P2 review round 1

Finding → fix (details in the phase report). Items that change contracts
other phases build on:
- **Signatures (for P3).** `ChatHeader({ conversationId })` and
  `MembersPanel({ conversationId, onClose? })` take ids and subscribe
  themselves; `ChatColumn` subscribes only to the selected id, its kind and
  the member-list flag. `ComposerShell` still takes the view, adapted by a
  memoised `ComposerSlot` in `ChatColumn` (P3 can drop it when the composer
  takes an id). `ProfilePopout`'s `conversationId` is optional and shows the
  "Group admin" chip.
- **Focus.** `Modal` records the opener and restores it on close (or
  `returnFocus()`), and on open focuses `[data-autofocus]`, else the first
  field, else the dialog (never the close button). `ui/hooks/focusTargets`:
  `focusConversation(id)` / `conversationFocusTarget(id)` land focus on the
  conversation's sidebar row (`[data-conversation-id]`); the composer should
  call `setConversationFocusResolver` so navigation lands in the composer.
- **Keyboard menus.** `ContextMenu` opens on Shift+F10, the ContextMenu key
  and Ctrl/Cmd+Enter (`isContextMenuKey`), listed in the shortcuts sheet.
- **Overlays.** `Drawer` takes `side: 'left' | 'right'`; the narrow member list
  uses the right-hand drawer.
- **Tokens.** New `danger-strong` (badge/danger-button fills), `radius-tile`;
  faint text, Linen accent/danger and avatar hues 1–6 retuned for 4.5:1.
- **Motion.** Reduced motion is centralised in `global.css` (stops keyframe
  animations as well as zeroing the duration tokens); components no longer
  carry their own reduced-motion blocks (P3's chat modules still do; harmless).
- **Clock.** `useNow(interval)` shares one timer per interval.
- **Tooling.** `verify-boundaries.mjs` only creates new, uniquely named
  fixtures (`__boundary_<pid>_<n>__.ts`), never touches existing files, and
  cleans up on exit, SIGINT/SIGTERM and at startup.
- **Dev dependency.** `vitest-axe` (MIT) for the axe smoke test; it pulls in
  `axe-core`, which is MPL-2.0 (dev/test only, not shipped).

### P3 Messaging

**Structure (`ui/features/chat`).** `ChatController` (one per column, React
context) wires the parts imperatively: the list registers
`jumpToPresent`/`reveal(id)`, the composer registers `addFiles`/`focus`, and
it holds the search-panel flag (`useSearchOpen`) so `ChatHeader` keeps its
id-only signature. A reveal for a conversation whose list isn't mounted yet
(mentions inbox) is queued and runs on mount. `ConversationArea` = pane +
composer + drop target; `SearchSlot` replaces the member list while search is
open (right drawer when narrow). `ComposerShell`/`ComposerSlot` are gone:
`MessagePane` and `Composer` take a `conversationId`. Folders: `list/`
(virtualiser, dividers, overlays, read tracking, row state), `message/` (row,
body, attachments, reactions, hover bar, menu, editor), `composer/`,
`header/` (search panel, pins, mentions inbox), `lib/` (pure helpers).

**Message list.** `react-virtuoso` with `firstItemIndex`. Deviation: the
index bookkeeping (`lib/indexTracker`) is keyed on render-item keys (nonce or
id; messages are ordered by `seq`), not on `seq` itself, because the items
include dividers. It shifts by how far the first surviving row moved; no
overlap ⇒ a new `epoch`, which remounts the virtualiser at the right start
(jump target, else the unread divider if it is > 12 rows from the end, else
the bottom). While older history is unloaded the window's leading day divider
is dropped: it would be a guess, and it moved to the new top on every
prepend, changing an already-measured row (visible jump). Rows render
`padding`, never margins (Virtuoso measures border boxes). While at (or opened
at) the bottom, `totalListHeightChanged` re-pins it so images/fonts settling
can't leave the newest message half-hidden. Hover and flash are exclusive
list-wide state (`list/rowState`), because a row scrolled out from under a
still pointer never receives `pointerleave`; keyboard focus (`:focus-visible`)
also activates a row, a mouse click inside it doesn't.

**Read state (core change).** `uiStore.scrolledUp[conv]` (absent = bottom
visible) is published by the list; `SyncService.isViewing` now also requires
it, so arrivals while scrolled up stay unread and feed the jump pill's
counter. The list marks read only when the window is anchored, its bottom is
visible and the window is focused (`useReadTracking`). P2's mark-on-open and
mark-on-focus in `useConversationLifecycle` were removed. The "N new messages
since HH:MM" bar counts what was unread at open (snapshot), shows while the
divider is above the viewport (measured against the scroller, not Virtuoso's
overscanned range), jumps to the divider or — if it isn't loaded —
`HistoryService.jumpToFirstUnread`, and its "Mark as read" keeps the divider.

**Core additions.** `SendService`: `edit` passes the original's quote as
`EditInput.quote`; `pin(conv, msg, pin)`, `adminDelete(conv, msg)`,
`deleteForMe(conv, msg)` (local: discard if unsent, else repository delete +
store remove; a later backfill could resurrect it — known gap) and
`capabilities { pin, adminDelete }`. `MessageRepository.pinned(conv, limit)`
(memory + IDB reverse scan). `HistoryService.jumpToFirstUnread`. `localStore`
gained `reactionUsage` + `noteReactionUsed` and
`localSelectors.quickReactions` (top 3, defaults 👍 ❤️ 😂). `AppServices` gained
`backend: Pick<ChatBackend, 'kind' | 'resolveAttachmentUrl'>` and
`repository: Pick<MessageRepository, 'search' | 'mentions' | 'pinned'>`.

**Rendering.** Body: `rangesToSegments` → elements; multi-line monospace is a
code block; spoilers are buttons until revealed; http(s) links open in a new
tab (`noopener noreferrer`); emoji-only bodies (≤ 10) are jumbo; `(edited)`
sits inline after the text; `preview` mode renders statically for results
lists (no nested controls). Mentions and author names open the profile
popout (`ProfilePopout` now exported by `members`). Names use the member-list
legibility mix of the contact hue; 16px avatars show a colour dot, not
initials. Attachments: allow-list in `lib/attachments` (raster images,
mp4/webm/mov, common audio; SVG only as an inline `data:` URL, i.e. the demo)
rendered only via `<img>/<video>/<audio>/<a download>`; URL-less attachments
resolve through `useAttachmentUrl` (`backend.resolveAttachmentUrl`, cached,
loading/error + retry). Grid of ≤ 4 (+N), single images sized from
width/height before load. `Lightbox` and `EmojiPicker`/`EmojiPickerPopover`
are new primitives (Radix Dialog; frimousse).

**Emoji data (privacy).** frimousse defaults to a public CDN; a Vite plugin
(`devserver/emojibase.ts`) serves `emojibase-data`'s `en/data.json` and
`messages.json` from our origin (middleware in dev/preview, emitted assets in
the build). `:shortcode:` autocomplete uses the same data plus GitHub
shortcodes (lazy chunk).

**Composer.** Plain textarea. Mentions are readable `@Full Name` text plus
tokens; on send each known label becomes U+FFFC and its id joins `mentionIds`
(an edited label is sent as text); restored drafts re-derive tokens from
member names. Autocomplete via `@floating-ui/react` above the field (listbox
with `aria-activedescendant` on the textarea; no `combobox` role, which axe
rejects on a textarea). Formatting shortcuts go through `execCommand
('insertText')` so they join native undo (fallback `setRangeText`). Slash
commands run on send (`send`/`replace`/`error`/`done`). Sending while detached
calls `jumpToPresent` first; replies carry the quoted message's attachment
types. Attachments live in composer state (lost on switching conversation —
known gap); **no spoiler toggle**: `OutgoingAttachment` has no spoiler flag.
Escape: dismiss autocomplete → cancel reply → mark read (empty). The composer
registers `setConversationFocusResolver`, so navigation lands in it (the P2
shell test now expects that).

**Commands.** `core.jumpToPresent` and `core.searchConversation` are
registered by `useChatCommands`. Header: pinned messages (only if the backend
pins), search toggle, mentions inbox.

**Dev only.** `app/devTools.ts` (dynamic import under `import.meta.env.DEV`):
`window.__shrike`, `__shrike.stress(n)` / `?stress=5000`, `__shrike.failNext()`.

**Known gaps.** Interactive pieces inside messages (avatar, name, images) are
still separate tab stops; ↑/↓ move between messages. Scroll position isn't
restored when switching back to a conversation (it opens at the bottom /
divider). Search highlights no terms. In happy-dom Virtuoso renders no rows at
an initial index, so the scroll + flash of a jump is verified by Playwright,
not unit tests.

### P3 review round 1

Finding → fix; contract-level changes first.
- **Core.** `OutgoingAttachment.previewUrl/width/height` (render-only, never
  sent): the optimistic message shows the composer's object URL, and it is kept
  after acknowledgement until the transport supplies a URL (a superseded `blob:`
  is revoked). The mock keeps own sends ≤ 1.5 MB as `data:` URLs (like the
  signal-cli adapter). `EditingTarget.draft/session` + `ui.setEditDraft`: the
  inline editor's text survives virtualisation; it autofocuses once per session.
- **Bottom pinning (B1, M2).** `list/bottomPin.ts` (pure, tested) owns
  "stuck": un-sticks beyond 64 px, re-sticks at the bottom or on jump. The
  scroller callback is stable (`useCallback`) — Virtuoso reattached an inline
  one per render and that reset the pin. The pin is set once per epoch. A
  ResizeObserver on the scroller re-pins when the composer grows.
- **Prepend (M1).** `skipAnimationFrameInResizeObserver`, measured default
  heights (comfortable 62 px, compact 28 px), and rows rendered as group starts
  keep their header after a prepend (collapsing one changed a measured row above
  the reader: the remaining ~38 px jump). Measured anchor movement: 0 px.
- **Index tracking (minor 14).** `advanceTrack` is a pure step held as React
  state and derived during render ("adjust state while rendering"), not a layout
  effect: the virtualiser must see the new index in the same render as the new
  data or it shows one frame of rows at stale indices.
- **Semantics (M3, M4).** The rows' container is `role="feed"` (not a live
  `log`); day/New dividers are plain text (a feed may only own articles). New
  arrivals are announced by a throttled `LiveAnnouncer` ("Name: text"). Rows are
  `role="article"`, labelled by a hidden "Name, time" (12/24 h setting) and
  described by the body; one roving tab stop (default: newest message; the
  scroller takes Tab when that row isn't rendered); inner controls are
  `tabindex=-1` until Enter enters the row (hover bar first in DOM order),
  Escape leaves it. `aria-keyshortcuts="Enter R E Plus Delete"`.
- **Touch (M9).** Under `(pointer: coarse)` or < 760 px there is no hover bar;
  a 450 ms long-press opens `MessageActionSheet` (bottom `Drawer`, same menu
  entries) and the reaction picker opens as a sheet. `Drawer` gained
  `side: 'bottom'`.
- **Render scope (M10, minor 7).** `MessagePane`/`MessageList` take only the
  id and select the title; rows subscribe to the names of the people they show
  (`useMessageNames`), not the whole contacts map. Verified: typing in the
  composer, typing indicators and unrelated contact updates re-render no rows.
- **Design (M8, notes a/b).** The New divider uses the accent: a sentence-case
  "New" pill at the start of the line (where the hover bar can't cover it) and
  an accent hairline. The "N new messages" bar floats inset with a shadow; it
  hides on "Mark as read", and after the divider was seen only while nothing is
  unread. Rail unread is a 6 px pip at the rail edge, clear of the ring.
- **Focus (M7).** Delete confirm focuses the destructive button
  (`data-autofocus`); after a delete focus goes to the next message, else the
  composer; the jump pill focuses the composer; quote jumps focus the target.
- **Composer/editor.** `useAutocompleteField` is shared by both (the editor gets
  @/: suggestions and honours `enterToSend`); IME guard includes keyCode 229;
  same-name members get disambiguated mention labels; inserted emoji get a
  trailing space and lose a redundant U+FE0F (kept where it selects emoji
  presentation).
- **Safety (minor 15).** `safeHref`: download links only for `blob:`, inert
  `data:` types (image/video/audio, text/plain, octet-stream — the last two so
  the demo's file cards download) and same-origin http(s).
- **frimousse a11y.** Rows/cells get 1-based `aria-rowindex/colindex`.
  frimousse finds the active row by that attribute to scroll it into view, so
  row scroll margins compensate exactly one row height.
- **Bundle.** frimousse is lazy (`EmojiPickerPanel`) and dnd-kit is lazy
  (`SortableRailList`, static tiles until loaded). **Not done:** dynamic import
  of the backend in `createShrike` — P4 is editing that file concurrently;
  recommended shape: a `deferredBackend` proxy (like `deferredRepository`) with
  per-kind capabilities known up front.
- **Not changed:** frimousse's localStorage data cache (NIT, ~280 KB).

### P4 Power UX

**Structure.** New: `ui/features/settings` (overlay, page registry
`pages.ts`, pure `search.ts`, `rows/` = `SettingsSection` + `SettingRow` +
filter context, `pages/`, `plugins/`, `themes/`, `keybinds/`, `about/`),
`ui/plugins` (built-ins with a UI half), `core/services/NotificationService`
+ `historyExport`, `core/themes/{sanitize,custom}.ts`,
`core/backend/signal-cli/probe.ts`, `app/deferredBackend.ts`. Primitives:
`CommandPalette` (cmdk wrapper; filtering always ours), `Select` (native),
`Slider`, `Segmented` (radio pattern), `Checkbox`, `ColorField`,
`CodeEditor`, `QrCode` (qrcode → one SVG path, no innerHTML),
`FullScreenDialog`; `Modal` gained `flush` and `size="xl"`, `Switch` an
external `id`, `IconButton` a `data-icon-button` hook. New deps: `cmdk`,
`qrcode` (MIT), dev `@types/qrcode` (MIT).

**Quick switcher.** `switcher/model.ts` ranks with `fuzzyMatch` (+2 mention,
+1 unread nudges; commands −6 when unscoped). Prefixes `>` `@` `#` `*`
become a chip in the field (Backspace on an empty scoped query drops it);
empty query = Unread (mentions first, muted only if mentioned) then Recent
(excluding the open conversation); `>` alone browses commands by category.
Rows: kind icon / space glyph, highlight, space name or "Direct message",
mention badge or unread dot, command keybind. Commands run *after* the
switcher closes (they may open a dialog). Focus: conversation → composer
via the P3 resolver; space → its rail tile; dismiss → opener.

**Settings.** `ModalHost` lazy-loads the overlay (`React.lazy`, own chunk,
same-backdrop fallback); `openModal({ type: 'settings', props: { page } })`
deep-links. Search: every term must match (case/accent-insensitive
substring; fuzzy was too loose), page-title match shows the whole page,
results render the matching rows of every page stacked; plugins and plugin
`settingsPanels` are searchable entries ("From plugins" nav group). Phones:
nav and page are separate screens. Rows are flex-wrap so small controls stay
beside the label and wide ones drop below. Pages: My profile (read-only:
Signal profile is edited on the phone), Privacy (receipts; Silent Typing /
Clear URLs toggled as plugins), Appearance (theme cards with live mini
previews, accent presets + custom with derived shades and a < 4.5:1
text-on-accent warning, density preview, 12/24h, text size, zoom),
Accessibility (reduced motion, `strongFocus` → `data-focus="strong"`,
`largeTargets` → `data-targets="large"`, saturation), Notifications
(permission flow incl. denied/unsupported, test notification, master
switch, all / mentions / nothing, previews, mute hint, sounds disabled:
we ship none), Keybinds, Behaviour (send key, markdown, typing — disabled
when Silent Typing is on —, link previews shown disabled: not built),
Plugins, Themes, Custom CSS, Connection (demo/signal-cli, URL, account, Test →
`admin.probeDaemon`; changes apply via confirm + reload), Data & storage
(`navigator.storage.estimate`, JSON export via Blob download, clear history
/ reset settings with confirm + reload; reset keeps the connection), About
(generated licence list).

**Settings store (no version bump; per-field parse).** `appearance.strongFocus`,
`appearance.largeTargets`, `customThemes: CustomThemeData[]`,
`saveCustomTheme` / `removeCustomTheme` (falls back to Dusk if active),
`resetKeybinds`, `resetPluginSettings`.

**Keybinds.** `keybinds/record.ts`: `recordKey` (via `keybindFromEvent`;
Escape/Tab cancel, Backspace/Delete unbind, bare modifiers keep listening),
`keybindProblem` (plain printable keys refused for `allowInInputs`
commands), `keybindConflicts` (both directions, after overrides). The
recorder owns Escape inside the settings dialog (`data-owns-escape`).
Per-row reset, Reset all; recording the default clears the override.
Palette commands added (no default keys): create space, toggle compact
mode, toggle notifications, open plugins/themes/appearance/keybinds. The
Ctrl+/ sheet links to Settings → Keybinds. All §4.11 commands were already
registered (P2/P3).

**Plugins.** Cards: name, description, authors, tags (click = tag filter),
"Required" chip, live switch, cog → `PluginSettingsModal` with the
auto-generated `PluginSettingsForm` (SettingRow per field: boolean →
Switch, string → input/textarea, number → Slider if min+max else number
input, select → Segmented ≤ 3 options else Select; values coerced through
the schema; Reset to defaults). Failed plugins show the error + Retry
(`runtime.start`). State lives on the card's left edge. Built-ins:
- Core stays React-free: `BUILTIN_PLUGINS` = Clear URLs, Silent Typing,
  Slash Basics, Keyword Alerts (now `createKeywordAlertsPlugin(ui)`).
  `previews.ts` removed.
- `ui/plugins`: Relative Timestamps (decoration, shared 1-minute `useNow`,
  absolute tooltip; "relative only" hides the header time via injected CSS
  on the stable `time[data-variant=header]` hook), Message Tools (hover
  actions Copy as Markdown / Word count toast + message-menu item; uses
  `toMarkdown`, now exported from `features/chat`), **Pronoun & Notes Badge**
  (decoration: first line of the private contact note, grapheme-safe cut,
  full note on hover; enabled by default). `withUiPlugins()` merges them and
  gives Keyword Alerts its highlight chip + `:has()` row tint.
- New capability `ctx.notifications.addBooster(fn)` (Registries
  `notificationBoosters`, `boostReason`): a reason string makes a message
  notify like a mention. Keyword Alerts uses it; its toast became optional.
- Known runtime quirk (unchanged): `setEnabled` reconciles twice (direct +
  settings subscription), so a plugin that fails *transiently* on enable is
  retried immediately.

**Themes / Custom CSS.** (Sanitiser and privacy rules superseded by review round 1, below.) `sanitizeUserCss` drops remote `@import` (http(s),
`//`, any `scheme://`; every syntax, case-insensitive) and reports remote
`url()` (kept, warned). The engine applies it to Custom CSS and theme CSS
whatever the caller does. Import/export `{ id?, name, kind?, tokens, css? }`:
only known token names (bare or `--shrike-` prefixed), string values that
can't break out of a declaration (`; { } < >` and comments refused), id
slugged from the name, built-in ids reserved, 200 kB file cap; stored themes
are re-validated (`toTheme`). Tokens left out keep Dusk's. Exporting a
built-in produces `<id>-copy`. Custom CSS: `CodeEditor` (gutter, Tab = two
spaces through `execCommand` for undo, Shift+Tab outdents, Esc releases Tab),
300 ms debounced apply (flushed on unmount), Reset, `data-shrike` hook list
in a `<details>` block. New tokens `qr-ink` / `qr-paper` (QR stays
black-on-white in every theme).

**Spaces and DnD.** Store: folder `hue?`, `renameFolder`, `setFolderHue`,
`dissolveFolder`, `placeRailEntry`, `moveCategory`. Create/Edit Space:
`ConversationChecklist` (fuzzy search, groups first, "moves from <space>"
hint, `suggestConversations`: shares the most members with the picks —
self excluded —, groups and unorganised first; nothing picked = recent
unorganised groups). Edit diffs membership (removed → Home). Rail
(building on P3's lazy `SortableRailList`): dropping a space on the middle
50% of a tile (`railDrop.isMergeDrop`) makes/joins a folder (drop ring;
sorting shift paused while merging), edges reorder. Folder menu: mark read,
expand/collapse, Rename and recolour (dialog), Dissolve. Space menu: Add to
folder ▸ / New folder with ▸, Remove from folder, Create category. Sidebar
uses **native HTML5 DnD** (`useConversationDrop`, MIME
`application/x-shrike-conversation`) instead of dnd-kit: it crosses rail ↔
sidebar without a shared DndContext and keeps dnd-kit lazy. Rows in a space
drag between categories (accent insertion line; `dropIndex` maps rendered →
store index), group rows from Home and any row in a space drop onto rail
tiles (move to space) or Home (unassign). Category header: right-click /
Shift+F10 / hover ⋯ → rename, create, move up/down, delete (rows move to
the first, toast). Empty categories show a dashed "Drag conversations
here". Keyboard alternatives: "Move to category ▸" in the conversation
menu, folder items in the space menu (dnd-kit keyboard sensors weren't used:
they'd fight the rail's roving tabindex). The rail tile dot/ring styling is
untouched (drop rings are outlines on the tile button).

**NotificationService (core/services).** Injected `NotificationApi`
(`browserNotificationApi()` default: silent, tag per conversation, icon).
Rules (`decideNotification`, pure): enabled and mode ≠ none, permission
granted; others' normal, non-deleted messages; never for the open
conversation when focused + visible + at the bottom; muted conversation
(incl. `until`) or space → mentions/boosts only; mentions-only → groups need
a mention/boost, DMs always notify. Previews hide spoilers; attachment-only
messages get a summary. One notification per conversation (replaced).
Click: focus window, close modals, open the conversation in its space.
`AppServices.notifications` = permission / request / test.

**Link device / account (§4.10).** `SyncService` now records
`session.errorKind` (duck-typed `error.kind`). `App` shows
`ConnectionSetup` for signal-cli `no-account` (lazy `LinkDevice`: QR from
`link.start()`, phone steps, device-name field defaulting to "Shrike
(Browser on OS)", waiting/expired/failed + new code; reducer in
`linkFlow.ts` ignores late results of abandoned attempts) → on success
retries `shrike.start()` (now safe to call again after a failed start), and
`account-required` (`AccountPrompt`: E.164 or ACI → settings → reload).
"Use the demo or another daemon" returns to the welcome screen. The welcome
Connect form probes the daemon first (fails inline, "Connect anyway").

**Composition root.** `createShrike` loads the backend with a dynamic import
per kind behind `deferredBackend(kind, ready)` (separate `mock` and
`signal-cli` chunks); `BACKEND_CAPABILITIES` declares each kind's optional
methods up front (a test checks them against the real adapters); early
`on()` subscriptions attach on load. `Shrike.backendReady` exposes the
concrete adapter (dev tools; P3's `MessageItem.test` updated to use it).
`AppServices` gained `backend.link`, `notifications`, `admin` (`probeDaemon`
— lazy signal-cli import —, `exportHistory`, `clearHistory`, `flush`).

**Licences.** `scripts/gen-licences.mjs` writes
`settings/about/licences.generated.ts` (runtime deps: name, version,
licence, URL); `about/licences.test.ts` fails when it drifts from
package.json or a non-permissive licence appears. Re-run (then Prettier)
after dependency changes.

**Known gaps.** dnd-kit isn't lazy for the *sidebar* because the sidebar
doesn't use it; native DnD has no touch support (menus cover it). The
keyword highlight tints only header rows (continuation rows carry no
decorations). My Profile is read-only. Notifications need the tab open (no
service worker). The link flow is verified against a mocked daemon only.
Custom light themes inherit Dusk for tokens they omit.

### Vim mode

A built-in plugin (`ui/plugins/vim`, id `vim-mode`), **off by default**.
User-facing reference: `docs/KEYBOARD.md`.

**Core: key layers (`core/commands/keyLayer.ts`, React-free).**
`KeyLayerStack` (owned by `Registries.keyLayers`) holds modal layers, newest
first; `handle(event, ctx)` offers the key to each layer's
`onKey(stroke, ctx) → handled`. `ctx` = `{ target: 'none' | 'list' |
'message' | 'composer' | 'input' | 'other', overlay, surface }`. The stack
drops IME composition (`isComposing` / keyCode 229) and bare modifiers.
`keyToken` turns events into Vim notation (`j`, `G`, `<C-d>`, `<Esc>`) with
the keybind convention: the produced character when it's printable ASCII,
else the physical key (a Cyrillic layout's J key is `j`). `KeySequencer`
does counts + prefix sequences + a timeout (`ManualScheduler`-testable);
`parseKeySequence` reads `"<leader>s"`-style bindings. `TextSurface` is the
DOM-free contract for an editable field (`read`, `write` — through the
editing pipeline —, `submit`, `escape` → `'reply' | 'read' | 'none'`,
`setSuggestionsEnabled`). New `PluginContext` capabilities (all tracked):
`ctx.keys.addLayer(layer)`, `ctx.commands.execute(id)` (plugins drive the app
through command ids, core ones included) and `ctx.composer.addAccessory(id,
component)` (slot `composer.accessories`, props `{ conversationId }`).
Settings schema fields may be `hidden` (internal state, not in the form).

**Dispatch.** `useKeyboard` adds a **capture-phase** window listener that
runs the layers before any widget (so Normal mode sees `j` before the
textarea or a message row does); a consumed key is `preventDefault` +
`stopPropagation`. With no layer installed it returns immediately and the
bubble-phase `KeybindDispatcher` path is unchanged. `describeFocus`
(ui/hooks) computes the context: registered text surfaces
(`registerTextSurface`, WeakMap by element) are `composer`, the scroller is
marked `data-message-scroller`, rows are `message`; any open dialog / menu /
listbox (including the composer's suggestion list) sets `overlay`, and Vim
then stays out of the way, so Esc closes popovers and the suggestion list's
keys keep working.

**Commands added (dogfooded by the plugin).** `NavCommand`: focus composer,
focus message list, next / previous space, command palette (switcher with
`props.query = '>'`; `QuickSwitcher` gained `initialQuery`) — all in the
palette, no default keys; `OpenSearch` (hidden). `MessageCommand` (hidden):
next / previous / first / last message, half page and line scrolling,
centre, and reply / edit / react / copy text / copy Markdown / delete / pin /
open on the focused message. The list implements them in
`list/useListNavigation.ts` (exposed as `ChatController.navigation`), over
the rendered rows like ↑/↓; per-row actions go through
`RowState.registerActions`, so row-local UI (reaction picker, delete
confirm) stays in `MessageItem`. `o` clicks the first `[data-open-attachment]`
tile, else reveals the quote.

**Engine (`ui/plugins/vim/engine`, pure TS).** `feed(state, token) →
{ state, effects, handled, rejected }` over `{ text, cursor, … }`; `sync`
adopts the field (typing, clicks; a mouse selection in Normal → Visual);
`selectionFor` gives the selection to render. Text is a `TextModel` of
grapheme clusters (`Intl.Segmenter`), so ZWJ emoji are one character.
Insert-mode keys are *not handled* and stay native (IME, suggestions,
spellcheck, native undo); the engine learns what was typed on Esc (diff
against the text at entry) for undo and `.`. Undo is the engine's own stack
(one step per change; a change plus its typed text is one step); writes go
through `execCommand('insertText')` on the minimal changed span, so native
undo still sees them. `.` replays the change's keys (count replaced when
given) plus typed text. Keys the engine rejects in Normal mode are offered to
an app-only sequencer (`gt`, `]u`, `:`, `/`, `?`, Ctrl+D/U/E/Y, the leader),
so those work from the composer without leaving it.

**Decisions.**
- *Block cursor*: a one-grapheme native selection in Normal mode, coloured
  by injected CSS on stable hooks (`:has([data-vim-mode=normal])
  [data-shrike=composer-input]::selection`). No overlay: it would have to
  track wrapping, scrolling and font metrics; the selection is exact for
  free. On an empty line the thin caret shows.
- *Esc / mark read*: Insert-mode Esc only switches mode. Normal-mode Esc
  with nothing pending runs the composer's own chain (cancel reply → mark
  read on an empty draft) and, when it marked read, focuses the list.
- *Navigation targets*: `none`, `list`, `message` only — not other buttons
  (Space/Enter must keep activating them) or text fields. Unmapped letters
  are swallowed there (they'd otherwise type-to-focus into the composer);
  Space stays native unless it is the leader.
- *Y* is `yy` (classic Vim), not Neovim's `y$`.
- *Timeouts* apply to app sequences only; an operator (`d…`) waits like Vim.
- *Settings*: navigation keys, composer modal editing, start in Insert (on),
  leader (Space / , / \ / ;), sequence timeout (300–3000 ms, default 1000);
  hidden `introShown` makes the intro toast one-time (reset with the
  plugin's settings). Individual Vim keys are not rebindable; the key map is
  read-only in Ctrl+/ (groups "Vim · …", from the layer's `help`) and in a
  plugin settings panel ("Vim keys").
- Per-conversation engine state (mode, undo, register) lives for the session.

**Known gaps.** Not supported: Ex commands, in-draft search, marks, macros,
named registers, Visual Block, `"+p`, Vim keys in the inline message editor
(it could register a `TextSurface` later). `.` after a count inside an
operator (`d3w` then `2.`) multiplies instead of replacing. Scrolling and
`gg`/`G` focus are verified with Playwright (happy-dom has no layout).


### P4 review round 1

Finding → fix (the full changelog is in the phase report).

- **B1 user CSS beacons.** `core/themes/sanitize.ts` rewritten: statements are
  split at `{ ; }` outside strings/comments/parentheses, each is judged on a
  normalised copy (`cssUnescape` + comments stripped + lower-cased), and any
  that references `@import` / `url(` / `image-set(` / `image(` /
  `cross-fade(` / `element(` with a non-`data:`/`blob:` target is dropped (a
  fetching block prelude drops its whole block). Output keeps surviving
  statements as written; the UI shows "Removed N remote references". Theme
  tokens: `tokenValues.ts` (kind per token, `CSS.supports` with a regex
  fallback, hard ban on `\`, `@`, resource functions, `; { } < >`, comments).
  Production CSP via `devserver/csp.ts` (`transformIndexHtml`, build only).
  Privacy copy updated.
- **M1** CodeEditor marks itself `data-owns-escape` until Tab is released, so
  the first Esc stays in the editor.
- **M2** Silent Typing retired: Privacy has one "Send typing indicators"
  switch (`behaviour.sendTypingIndicators`). Settings v3 migrates an enabled
  plugin into `false` and drops its entry. Typing guards remain a plugin API.
- **M3** Safe mode (`ShrikeOptions.safeMode`, `Shrike.safeMode`,
  `AppServices.safeMode`; main.tsx reads `?safe=1` or a held Shift during the
  first 1.5 s and reloads into `?safe=1`). Themes with CSS: 10 s Keep/Revert
  bar (reverting needs no click); same-id imports ask before replacing.
- **M4** Token `accent-text` (+ `DUSK_BASE`, `deriveAccentText`,
  `accentContext`) used for every accent-coloured text; Appearance warns when
  accent vs `bg-chat` < 3:1; tests cover every preset on every theme.
- **M5** Runtime applies only the plugins whose flag changed, `setEnabled`
  applies once (directly before `startAll`, via the subscription after),
  reconcile skips failed slots, `retry(id)` serves the Retry button.
- **M6** Groups You · General · Customise · System; "Custom CSS" everywhere
  (page id `custom-css`, store `customCss`, style tag `shrike-custom-css`);
  "← Back to chats" atop the nav; keyword highlight = accent chip + dotted
  accent underline via the CSS Custom Highlight API on
  `[data-shrike="message-body"]` (new stable hook), no row tint; open folders
  use a 2px folder-hue bracket.
- **M7** Phones: entering a page focuses its h2, "All settings" returns focus
  to the nav item, the page bar has a 36 px close.
- **M8** Export skips messages with `expiresAt` and lists attachments as
  `{ contentType, fileName?, size? }` only.
- **M9** Create Space: chips of the picks under the search; suggestions freeze
  while the pointer/focus is in the list and refresh after 300 ms of stillness.
- **Minors:** quiet focus restore (no tooltip, `focusQuietly`); switcher
  ranking (unread bonus capped at 2, command penalty 2 on word starts, 40 %
  floor, `Theme: X, kind` commands, tappable scope hints, person icon for
  DMs); keybinds (Reassign/Cancel prompt, browser-reserved warning, per-command
  search rows, 36 px recorder); roving nav and accent swatches; focus after
  Retry / link failure / notification click (composer, via
  `NotificationService.onOpened`); crash chip named by `PluginNamesContext`,
  once per plugin; keyword toasts follow the viewing rule; toasts sit above
  the composer; notification clicks only close dialogs without input;
  link copy; `dist/THIRD_PARTY_NOTICES.txt` from the bundle graph
  (`devserver/notices.ts`, transitive deps, linked from About); checklist meta
  contrast; lazy switcher (prefetched when idle), onboarding screens and
  `IdbMessageRepository`; Notes badge off by default; deferred backend reports
  `connecting`; honest receipts copy; typed page registry (`PAGE_IDS`,
  exhaustive view map); compact plugins bar inside search results.
- **NITs:** "Built in" byline, one-decimal slider, Link previews row removed,
  single empty-name error, hex `aria-invalid`, row labels wired to Segmented /
  Slider, folder names, ⋯ on rows and a menu hint in empty categories, `/me`
  keeps your name.

### P6 polish B

Code quality, extensibility and correctness fixes from the final review.

- **Vim + IME (blocker).** A composition starting outside Insert mode used to
  replace the block cursor's character and bypass the engine's undo. The
  plugin now listens for `compositionstart` and the keyCode-229 keydown
  before it (capture phase) and calls `VimController.onCompositionStart`:
  collapse the caret and `enterInsert(state, 'cursor', ['i'])`, so the
  composed text is one Insert change (one `u`, repeatable with `.`).
- **Vim robustness.** `describeFocus` (`ui/hooks/textSurfaces.ts`) counts an
  overlay only if it contains focus, is controlled by the focused field
  (`aria-controls`/`aria-owns`/`aria-activedescendant`: the composer's
  suggestions) or is an open modal (`[aria-modal]`, open alertdialog/menu);
  a persistent listbox elsewhere no longer disables Vim. Counted app keys
  (`5J`) run sequentially, each awaiting the previous `execute` (single keys
  still run at once). The composer's `aria-describedby` points at the pill's
  "Vim: Normal mode" text (new `ComposerSlotProps.descriptionId`).
- **Vim engine split.** `engine/engine.ts` (1279 lines) → `engine.ts`
  (public API, 180), `types.ts`, `parse.ts`, `exec.ts` (editing
  primitives), `normal.ts`, `visual.ts`, `operators.ts`, `insert.ts`,
  `undo.ts`, `dot.ts`, `positions.ts`; no cycles (`.` gets `feed` injected).
  Public API unchanged except the dead `enterNormal`, removed.
- **Vim lazy-loaded.** `vimPlugin.ts` is just the definition and `settings.ts`;
  `start()` imports `startVim.ts` (engine, controller, pill, keys panel: a
  ~36 kB chunk) the first time the plugin starts.
- **Sanitiser.** `src(` joins the resource functions (`RESOURCE`,
  `targetsOf`); a `var()` inside `src(`/`image-set(` counts as remote.
- **Plugin API.** Typed slot props (`ComponentLike<P>`, `MessageSlotProps`,
  `ComposerSlotProps`, `IconComponent`, `PanelComponent`; `OpaqueComponent`
  removed); `ctx.messages.reply/react/copy` (host services in
  `app/pluginHost.ts`); `ctx.state()` + `usePluginState`;
  `onMessage(fn(message, { live }))` via the new `SyncService` event
  `messageArrived`; `ctx.conversations.get/isDirect`. Hover action, menu item
  and header button failures (and async rejections) go through
  `Registries.invoke`/`isVisible` to `onError`; the app records them with
  `PluginRuntime.reportRuntimeError` and the card shows them with Retry
  (which restarts a running plugin). Command errors are now attributed to the
  owning plugin, not the command id.
- **Backend registry.** `BackendKind` is a string; `app/backends.ts` holds
  `BackendRegistration`s (`kind`, `label`, `description`, `load()`,
  `capabilities`, `history`, `settingsSchema?`, `onStarted?`, `attach?`).
  The mock's seeding and liveliness moved into its registration;
  `deferredBackend(kind, capabilities, ready)` replaces
  `BACKEND_CAPABILITIES`; the settings parser takes `isBackendKind` from the
  registry (`createSettingsSchema`); Settings → Connection lists the
  registered kinds (`AppServices.backends`). `BackendChoice` is gone.
- **MessageRef generalisation: not done.** It touches every adapter, both
  services and most of their tests; written up as a design note with every
  touch point and a migration order (ARCHITECTURE.md, "Future: opaque
  message ids").
- **Housekeeping.** `package.json` licence `UNLICENSED` (README: none chosen);
  stale comments (core-commands JSDoc, sanitiser CSP location, this
  section's `handle`, "community-style"); lint zones for top-level files
  (`main.tsx`) vs adapters, `ui/hooks` (no features/plugins) and `ui/plugins`
  (features only through their index; no `app/`), with fixtures in
  `verify-boundaries.mjs`; dead exports un-exported (`UI_PLUGINS`,
  `displayKeys`, `keywordRanges`, `fieldFor`, `probeAdvice`,
  `accentContrast`, `shortDuration`) or removed (`enterNormal`).
  `createShrike.ts` 531 → ~315 lines (`backends.ts`, `pluginHost.ts`,
  `coreCommands.ts`); `SendService`'s attachment-preview helpers moved to
  `localAttachments.ts`. `SignalCliBackend` was left whole: send params and
  normalisation are already separate modules, and the group handling is tied
  to its event queue and state.


### P6 polish A

Finding → fix (the reviewer's numbering).

- **1 Alt+↑/↓ lost focus.** `followConversationFocus()` (`ui/hooks/focusTargets.ts`)
  is captured before a command switches conversation and applied after: from a
  sidebar row focus moves to the new row; from the chat column, `<body>`, or
  anywhere the switch removed, it lands in the new composer. `stepSidebar` and
  `jumpToUnread` use it, so Vim J/K/]u follow too (they run the same
  commands); the switcher and notification clicks already focus the composer.
- **2 Pending contrast.** No opacity: pending body text is `text-muted`, the
  author keeps its colour, and a 12px clock with hidden "Sending" follows the
  text. Failed/deleted states are covered by the token checks below.
- **3 Switcher empty state.** `CommandPaletteList` takes `empty`: the listbox
  stays mounted but `hidden` (aria-controls still resolves) and the message is
  a `role="status"` outside it.
- **4 Profile at 390.** `ProfileTrigger` (members feature): a bottom `Drawer`
  sheet below 760px, a collision-avoiding popover elsewhere. Member rows, author
  names/avatars and mentions use it. Drawer scrim and panel share one z-index so
  a nested sheet stacks above its parent drawer.
- **5/6 Settings.** Theme cards use `name={useId()}`. `SettingsSection rowIds`
  hides headings (keybind categories, Danger zone) with no matching rows.
- **7 Drawer.** One Esc closes it from any descendant: a capture listener
  registered on open runs before a tooltip layer, while layers opened from the
  drawer keep focus outside its DOM and close first. The opener is recorded on
  each open and gets focus back on close or unmount (`returnFocus` fallback:
  the hamburger, the member toggle), including when focus was inside the panel
  as it animated out.
- **8 Contrast.** `textSurfaces(theme)` lists the opaque colours text sits on
  (four surfaces, hover over each, selected over chat/sidebar; `compositeOver`).
  `accent-text` is derived against the hardest one (Dusk → `#e58359`).
  Dusk muted/faint `#aaadb2`/`#9b9ea4`, danger `#f26781`; Midnight faint
  `#8a8d92`; Linen muted/faint/link/warning `#534e4a`/`#605a55`/`#98431d`/`#855400`.
  `contrast.test.ts` checks text, muted, faint and link on every composite,
  danger/warning on hovered surfaces, and accent-text for every preset × theme.
- **9 Landmarks.** "Pick a conversation" is the h1 when nothing is open (the
  chat header's h1 otherwise); autocomplete is `role="region"` "Suggestions";
  the ConnectForm command scroller is focusable and labelled. Axe: 0 violations
  across 4 themes × {1440, 390}. Radix menu/tooltip portals are excluded from
  the `region` rule only: they are transient popups owned by a trigger inside a
  landmark.
- **10 Bundle.** Lazy: Lightbox (mounted on first open), autocomplete popover
  (+ floating-ui, prefetched when idle), space/folder/category dialogs and the
  shortcut sheet (prefetched with the switcher), the search panel. Index
  549 → 491 kB (with B's lazy Vim).
- **11** Emoji picker and popovers restore focus with `focusQuietly`; the hover
  bar and the time tooltip hide while the row's context menu is open.
- **12 Tokens.** `radius-2xs`, `font-size-hero`, `font-size-emoji-sm`,
  `font-size-emoji` (emoji follow text size); raw sizes and radii replaced.
  Settings nav icons stay 18px: next to the 15px labels they read balanced in
  screenshots, and 16px looked undersized.
- **13** "Reset…" has an icon like "Clear…"; "Set up keyword alerts" is a
  secondary button.
- **14** Drop overlay tolerates a null `dataTransfer`, and leave/drop always
  settle it.
- **15** `pluginMenuEntries` (icons, visibility, failure reporting) feeds the
  conversation, space and member menus. The member row has a context menu
  (Profile, Message, Copy phone number, plugin items), and the profile shows
  plugin member actions. `STYLE_HOOKS` lives in `core/themes/styleHooks.ts`; a
  test checks it against every `data-shrike` value in `src` and the THEMING
  table. Imports drop engine tokens with a warning; exporting a built-in writes
  resolved tokens (`resolvedThemeTokens`). The conversation menu has a
  "Disappearing messages" submenu, and the group details popover offers
  "Rename group" (admins only). Both go through `SendService.updateConversation`
  (+ `capabilities.updateConversation`); the mock now writes the "You set…"
  system line, as signal-cli already did.
- **16** `spaces.ts` says "community-style".
- **From B's review.** `tokenValues` rejects `src(`. `MessageItem`'s Escape and
  `useTypeToFocus` reuse `overlayOwnsKeys`/`describeFocus`.
