# Hearth — Build Plan

> A community-style desktop-class chat UI for the Signal network, driven by a
> local `signal-cli` daemon. Server-rail / channel-list / chat / member-list
> layout, deep theming, and a first-class plugin system.

This document is the source of truth for builders and reviewers. If an
implementation decision contradicts this plan, either follow the plan or update
the plan in the same change with a justification.

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

- Original name ("Hearth"), original logo (simple SVG glyph drawn by us),
  original palette (default accent: warm ember `#ff7a59`, *not* Discord
  blurple or Signal blue), original iconography (lucide-react, ISC).
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
  them into `hearth/`.

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
| Fuzzy search       | small in-house scorer (no dep)                      | quick switcher |
| QR                 | `qrcode` (MIT)                                      | device linking |
| Tests              | Vitest + Testing Library + happy-dom                | |
| Lint/format        | ESLint (typescript-eslint, react-hooks, import boundaries) + Prettier | |

Package manager: **npm**. Node ≥ 20.

## 3. Architecture

```
hearth/src/
  app/                 # composition root: providers, bootstrap, routing of views
  core/                # NO React imports allowed here
    domain/            # pure types + pure helpers (ids, time grouping, body ranges)
    backend/           # ChatBackend contract + adapters
      types.ts
      mock/            # rich demo world with simulated activity
      signal-cli/      # JSON-RPC over HTTP + SSE event stream
    persistence/       # MessageRepository (IndexedDB) + settings storage
    stores/            # zustand vanilla stores (one file per slice)
    services/          # orchestration: sync engine, send pipeline, notifications
    plugins/           # plugin runtime, extension registries, built-in plugins
    themes/            # token definitions, built-in themes, theme engine
    commands/          # command registry (keybinds, slash cmds, palette actions)
  ui/
    primitives/        # Button, Avatar, Tooltip, Popover, Menu, Modal, Input, Switch, Badge, Kbd, Scroller…
    hooks/             # generic React hooks (useStore selectors, useHotkey, useResizeObserver)
    features/          # one folder per product area
      rail/            # spaces rail
      sidebar/         # conversation list, user panel
      chat/            # header, message list, message, composer
      members/         # member list, profile popout
      settings/        # full-screen settings
      switcher/        # quick switcher (Ctrl+K)
      onboarding/      # connect / link device
      spaces/          # create/edit space dialogs
    styles/            # global.css, tokens.css, reset
  test/                # test utils, fixtures
```

**Dependency rules (enforced by ESLint `import/no-restricted-paths`):**
- `core/**` must not import `ui/**`, `app/**`, `react`.
- `core/domain` imports nothing else from `core`.
- `ui/primitives` must not import `ui/features` or `core/**` (pure presentational).
- `ui/features/*` may import `core/**`, `ui/primitives`, `ui/hooks`, and
  another feature only through that feature's `index.ts`.
- Adapters under `core/backend/*` are only imported by `app/` (composition root).

### 3.1 Domain model (`core/domain`)

```ts
type ConversationId = string & { __brand: 'ConversationId' } // `dm:<aci|number>` | `group:<base64id>`
type MessageId = string & { __brand: 'MessageId' }           // `${authorId}:${sentAt}` — Signal identifies messages by (author, timestamp)

interface Contact { id: string; number?: string; name: string; profileName?: string;
  about?: string; aboutEmoji?: string; color: string /* derived, stable */; avatarUrl?: string; isSelf?: boolean; blocked?: boolean }

interface Conversation { id: ConversationId; kind: 'direct' | 'group'; title: string;
  description?: string; avatarUrl?: string; memberIds: string[]; adminIds: string[];
  muted: boolean | { until: number }; archived: boolean; pinned: boolean;
  expireTimerSec: number; lastActivityAt: number; draft?: string }

type TextStyle = 'bold' | 'italic' | 'strikethrough' | 'monospace' | 'spoiler'
interface BodyRange { start: number; length: number; style?: TextStyle; mentionId?: string }

interface Message { id: MessageId; conversationId: ConversationId; authorId: string;
  sentAt: number; receivedAt: number; body: string; ranges: BodyRange[];
  quote?: { authorId: string; sentAt: number; text: string };
  attachments: Attachment[]; reactions: Reaction[]; edits?: number /* count */;
  editedAt?: number; deleted?: boolean; expiresAt?: number;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; // outgoing only
  kind: 'normal' | 'system'; systemText?: string; pinned?: boolean }

interface Reaction { emoji: string; authorId: string; at: number }
interface Attachment { id: string; contentType: string; fileName?: string; size?: number;
  width?: number; height?: number; url?: string /* resolved blob/http url */; blurhash?: string }
```

Pure helpers (all unit-tested):
- `groupMessages(messages, { gapMs: 7*60_000 })` → render items: day dividers,
  "new messages" divider, author groups.
- `parseMarkdownToRanges(text)` → `{ body, ranges }` converting `**b**`,
  `*i*`/`_i_`, `~~s~~`, `` `code` ``, `||spoiler||` into Signal body ranges
  (so formatting is **native** for recipients on official apps).
- `rangesToSegments(body, ranges)` → nested segment tree for rendering.
- `fuzzyScore(query, candidate)`.
- `colorForId(id)` → one of 12 theme-provided avatar hues.

### 3.2 Backend contract (`core/backend/types.ts`)

```ts
interface ChatBackend {
  readonly kind: 'mock' | 'signal-cli'
  connect(): Promise<void>; disconnect(): Promise<void>
  getStatus(): ConnectionStatus  // 'connecting' | 'online' | 'offline' | 'error'
  getSelf(): Promise<Contact>
  listContacts(): Promise<Contact[]>
  listConversations(): Promise<Conversation[]>
  send(input: SendInput): Promise<{ sentAt: number }>        // body+ranges, quote, attachments, mentions
  edit(input: EditInput): Promise<{ sentAt: number }>
  react(input: ReactInput): Promise<void>                    // add/remove
  deleteForEveryone(conv: ConversationId, sentAt: number): Promise<void>
  setTyping(conv: ConversationId, typing: boolean): Promise<void>
  markRead(conv: ConversationId, messages: { authorId: string; sentAt: number }[]): Promise<void>
  updateConversation?(conv: ConversationId, patch: Partial<Pick<Conversation,'muted'|'expireTimerSec'|'title'|'description'>>): Promise<void>
  link?: { start(): Promise<{ uri: string }>; finish(uri: string, deviceName: string): Promise<{ accountId: string }> }
  on<E extends keyof BackendEvents>(event: E, fn: (p: BackendEvents[E]) => void): Unsubscribe
}
interface BackendEvents {
  status: ConnectionStatus
  message: Message                    // incoming or sync-sent
  messageEdited: { conversationId; authorId; targetSentAt; body; ranges; editedAt }
  messageDeleted: { conversationId; authorId; targetSentAt }
  reaction: { conversationId; targetAuthorId; targetSentAt; reaction: Reaction; remove: boolean }
  receipt: { authorId; sentAts: number[]; type: 'delivered' | 'read' | 'viewed' }
  typing: { conversationId; authorId; typing: boolean }
  conversationUpdated: Conversation
  contactUpdated: Contact
}
```
Adapters translate protocol quirks into these events. The UI never sees raw
envelopes.

### 3.3 Stores (`core/stores`, zustand/vanilla)

One slice per file, each exporting `createXStore()` and a typed selector set:
- `sessionStore` — backend kind, connection status, self contact.
- `contactsStore` — `Record<id, Contact>`.
- `conversationsStore` — `Record<id, Conversation>`, derived ordering,
  unread & mention counts, read cursors.
- `messagesStore` — per-conversation windows `{ ids, byId, hasMoreBefore, loading }`,
  optimistic inserts keyed by client nonce.
- `typingStore` — ephemeral `Record<conv, Record<author, expiresAt>>`.
- `spacesStore` (persisted) — local organisation: spaces, categories,
  conversation → space/category assignment, order, collapsed state.
- `uiStore` — selected space & conversation, panel visibility, open modal,
  reply target, editing target, scroll anchors per conversation.
- `settingsStore` (persisted, versioned with migrations) — appearance,
  notifications, behaviour, keybind overrides, plugin enabled/settings.

Services wire backend events → stores and actions → backend:
- `SyncService`: subscribes to backend events, persists messages to the
  repository, updates stores, computes unread/mentions.
- `SendService`: optimistic send, retries, failure state, markdown → ranges,
  runs plugin `beforeSend` transforms.
- `NotificationService`: desktop notifications (Notification API) honouring
  mute / mention-only / focus state.

### 3.4 Extension system (`core/plugins`) — the "Vencord" layer

We do **not** monkey-patch. The app exposes typed *extension points*; the
core features are themselves written against the same points where
reasonable (dogfooding keeps them honest).

```ts
definePlugin({
  id: 'clear-urls', name: 'Clear URLs', description: 'Strips tracking params from links you send.',
  authors: ['hearth'], tags: ['privacy'],
  settings: defineSettings({ extraParams: { type: 'string', label: 'Extra params', default: '' } }),
  start(ctx) {  // ctx: PluginContext — scoped, auto-disposed on stop
    ctx.send.addTransform((draft) => ({ ...draft, body: strip(draft.body, ctx.settings.get('extraParams')) }))
  },
})
```

`PluginContext` capabilities (each returns a disposer, all tracked for stop):
- `ctx.commands.register({ id, title, keybind?, run })` — palette + hotkeys.
- `ctx.slash.register({ name, description, options, execute })` — `/shrug`, `/me`…
- `ctx.send.addTransform(fn)` — outgoing draft pipeline.
- `ctx.messages.addAccessory(Component)` — rendered under a message.
- `ctx.messages.addDecoration(Component)` — badge next to author name.
- `ctx.messages.addHoverAction({ id, icon, label, onClick })`.
- `ctx.menus.add('message' | 'conversation' | 'member' | 'space', items)`.
- `ctx.headerBar.addButton(...)`, `ctx.settingsPanels.add(...)`.
- `ctx.styles.inject(css)`.
- `ctx.stores` (read + subscribe), `ctx.backend` (narrow facade), `ctx.toast`, `ctx.log`.
- `ctx.settings.get/set/subscribe` (typed from the schema).

Plugins that render UI supply React components; the runtime is React-agnostic
(components are opaque values stored in registries; `ui/` renders them via
`<Slot name="message.accessories" …/>`). Each slot is wrapped in an error
boundary: a crashing plugin shows a small inline "plugin X failed" chip and
never takes down the app.

Built-in plugins (ship at least these, prove the API):
1. **Clear URLs** — send transform.
2. **Silent Typing** — suppress outgoing typing indicators.
3. **Slash Basics** — `/shrug`, `/tableflip`, `/me`, `/spoiler`.
4. **Relative Timestamps** — "3m ago" style toggle via decoration.
5. **Keyword Alerts** — notify & highlight on custom keywords.
6. **Message Word Count** / *Copy as Markdown* hover action (tiny demo).

### 3.5 Theming (`core/themes`, `ui/styles`)

- All colour/space/radius/shadow/motion values are CSS custom properties
  (`--hearth-*`) defined in `tokens.css` for the base (dark) theme.
- A theme = `{ id, name, tokens: Partial<Record<TokenName,string>>, css?: string }`
  applied to `:root` via a single `<style id="hearth-theme">`.
- Built-in: **Ember (dark, default)**, **Midnight (OLED black)**, **Linen (light)**,
  **High Contrast**.
- Appearance settings: theme, accent colour (overrides `--hearth-accent*`,
  derived shades via OKLCH computations), message density (cozy/compact),
  font scale (87.5–125%), UI zoom, saturation, reduced motion, show avatars
  in compact mode, 12/24h time.
- **QuickCSS**: live-editing textarea (monospace, tab-indent) injected last.
- Stable styling hooks: every major region carries a `data-hearth="region-name"`
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
- **Home** at top (Hearth glyph): all DMs + unassigned groups. Unread
  indicator = small accent bar on the left edge; mention count = red badge
  bottom-right of the icon.
- Separator, then **Spaces**: local, user-defined collections of Signal
  groups (and optionally DMs), shown as rounded-square tiles with emoji or
  initials on a chosen colour. Tooltip with name on hover (right side).
- Selected space: tile gets a stronger radius change + full-height edge bar.
- Drag to reorder; drag tile onto tile creates a **folder** (expand/collapse).
- `+` tile → Create Space dialog (name, emoji/colour, pick groups with a
  searchable checklist; suggestions based on shared members).
- Right-click tile: Mark all read, Mute space, Edit, Delete (confirm; groups
  return to Home).
- Bottom: connection health dot (only visible when not online).

### 4.3 Sidebar
- Header: space name + chevron (space menu) or "Home" with search button
  "Find or start a conversation" that opens the quick switcher.
- In Home: sections **Pinned**, **Direct Messages**, **Groups**, each
  collapsible, sorted by last activity. Rows: avatar (DMs) / group glyph,
  title, one-line preview (DMs only when hovered? → no: show a muted last-message
  preview for DMs and groups in Home; hidden in Spaces for a cleaner channel feel),
  unread = bold title + white text, mention badge, muted = 50% opacity, typing
  = animated dots replacing preview.
- In a Space: collapsible **categories** (user-created; default "Chats") with
  channel-style rows: `#` glyph, title, badges. Drag rows between categories.
- Row hover shows a close/archive `×` (Home) or settings cog (Spaces).
- Right-click row: Mark as read, Mute ▸ (15m/1h/8h/24h/until I turn it back
  on), Pin/Unpin, Move to space ▸, Copy ID, Disappearing messages ▸, Archive.
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
- **Message anatomy (cozy):** 40px avatar, author name (contact colour) +
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
- Attachment tray above the input with thumbnails, remove ×, spoiler toggle.
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
- Sections: **Admins — N**, **Members — N**. Rows: avatar, name (colour),
  about-emoji. No fake presence.
- Click → **profile popout** anchored to the row: banner in contact colour,
  large avatar, name, profile name, about, number (if shared), "Message"
  button, "Copy safety-number hint" (safety number verification itself is
  done on the phone), note field (local, persisted).

### 4.8 Quick switcher (Ctrl/Cmd+K)
Modal with fuzzy search over conversations, spaces and commands (prefix `>`
for commands, `@` DMs only, `#` groups only). Empty query shows recent &
unread. Result rows show kind icon and space name. Enter opens, Shift+Enter
opens without closing? (no — keep simple).

### 4.9 Settings (full-screen overlay, Escape to close)
Left nav grouped: **User** (My Profile, Privacy), **App** (Appearance,
Accessibility, Notifications, Keybinds, Behaviour), **Hearth** (Plugins,
Themes, QuickCSS), **Advanced** (Connection, Data & Storage — export/clear
local history, About/licences). Changes apply live; no Save button. Search
box filters settings entries.
- **Plugins page:** grid of cards (name, description, tags, toggle, cog →
  auto-generated settings form from schema). Search + filter (enabled /
  disabled / tag). Restart-free enable/disable.
- **Themes page:** theme cards with live mini-preview swatches; accent picker.

### 4.10 Onboarding / connection
First run: welcome screen with two choices: **Try the demo** (mock backend,
seeded world) or **Connect to signal-cli** (daemon URL, default
`http://127.0.0.1:8080` via dev proxy). If the daemon has no account: **Link
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

### 4.12 Accessibility & motion
- All interactive elements reachable by keyboard; visible focus ring
  (`:focus-visible`, 2px accent outline, offset 2px).
- Message list uses `role="log"` + `aria-live="polite"` for new messages.
- Colour contrast ≥ 4.5:1 for text in all built-in themes.
- Motion 120–200ms `cubic-bezier(.2,.8,.2,1)`; everything disabled when
  reduced motion (OS or setting).
- Hit targets ≥ 32px in rail/sidebar.

### 4.13 Visual language
- Base dark neutral with a hint of warmth (not pure grey): rail `#101114`,
  sidebar `#15171b`, chat `#1b1d22`, elevated `#22252b`, floating `#0c0d10`,
  border `rgba(255,255,255,.06)`, text `#e9e7e4`, muted `#a4a1a0`,
  faint `#6f6c6b`. Accent ember `#ff7a59`, danger `#f0506e`,
  success `#3ccf91`, warning `#f5b44a`, mention bg `rgba(255,122,89,.10)`.
- 12 avatar hues tuned for contrast in each theme.
- Type: Inter; message 15px/1.375, UI 14px, headers 16px 600,
  section labels 12px 600 uppercase +0.02em tracking.
- Radii: 4 / 8 / 12 / 16; spaces tiles 16 → 12 when selected.
- Shadows only on floating layers (menus, popouts, modals).

## 5. Mock backend world
Seeded, deterministic (seeded PRNG), ~25 contacts, ~12 groups, ~10 DMs,
realistic multi-day histories including replies, reactions, edits,
deletions, attachments (generated SVG/data-URL images), mentions, formatting,
long messages, code. A "liveliness" simulator emits typing + messages +
reactions every few seconds in a couple of conversations (toggleable in
Advanced settings). Default spaces pre-created on first demo run ("Work",
"Climbing Club", "Family") so the Discord-like structure is visible
immediately.

## 6. Delivery phases

Each phase: **builder** implements → **reviewer** audits (code quality +
UX against §4 + plan conformance) → builder fixes → orchestrator verifies
gates and commits. Quality gates for every phase:
`npm run typecheck && npm run lint && npm test && npm run build` all green.

| Phase | Scope | Acceptance |
|---|---|---|
| **P1 Foundation** | Scaffold, tooling, lint boundaries, tokens/themes base, domain types + pure helpers (with tests), backend contract, mock backend + seed world, IndexedDB repository, stores, services (sync/send), plugin runtime + registries (headless), command registry | Headless tests cover grouping, markdown→ranges, segments, fuzzy, stores, plugin lifecycle, mock backend events |
| **P2 Shell** | App bootstrap, primitives, rail, sidebar, chat header, user panel, member list, profile popout, responsive layout, onboarding (demo path) | App boots into demo with seeded spaces; navigation works end-to-end by keyboard and mouse |
| **P3 Messaging** | Message list, message rendering, reactions, replies, attachments + lightbox, hover bar, context menu, composer with autocomplete/attachments/edit/reply, typing, unread divider, jump-to-present | Send/edit/react/reply/delete all work optimistically against mock |
| **P4 Power UX** | Quick switcher, settings overlay (all pages), plugins UI + built-in plugins, themes + accent + QuickCSS, keybinds, spaces CRUD + drag & drop, notifications | All built-in plugins toggle live; theme changes live |
| **P5 signal-cli** | Adapter (JSON-RPC HTTP + SSE with Last-Event-ID resume), envelope normaliser (tested with fixtures), attachments, link-device flow, Vite proxy, README setup guide | Fixture-driven tests; manual run doc |
| **P6 Polish** | Visual QA via Playwright screenshots of every surface in 3 themes & 3 widths, a11y audit (axe), perf (10k-message conversation smooth), docs (ARCHITECTURE.md, PLUGINS.md, THEMING.md) | Reviewer sign-off |

## 7. Code conventions
- Named exports only; one component per file; file = component name.
- Components ≤ ~200 lines; extract hooks (`useX`) for logic.
- No `any`; `unknown` + narrowing at boundaries (adapters validate input).
- Store access in components via selector hooks only (no whole-store subscriptions).
- CSS Modules: `Component.module.css` next to component; only tokens, never
  raw hex outside `tokens.css`/theme files.
- Tests colocated as `*.test.ts(x)`.
- Comments explain *why*, not *what*.
