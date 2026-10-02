# Shrike — Build Plan

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
  app/                 # composition root: providers, bootstrap, routing of views
  core/                # NO React imports allowed here
    domain/            # pure types + pure helpers (ids, time grouping, body ranges)
    lib/               # leaf utilities: typed Emitter, Clock/Scheduler, disposables, observable lists
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
- `core/domain` imports nothing else from `core`; `core/lib` likewise.
- `ui/primitives` must not import `ui/features` or `core/**` (pure presentational).
- `ui/features/*` may import `core/**`, `ui/primitives`, `ui/hooks`, and
  another feature only through that feature's `index.ts`.
- Adapters under `core/backend/*` are only imported by `app/` (composition root)
  (test files may import the mock).
- `scripts/verify-boundaries.mjs` (run by `npm run lint`) lints fixture files
  in each layer and fails if any of these rules stops firing.

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
  authors: ['shrike'], tags: ['privacy'],
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
  (`--shrike-*`) defined in `tokens.css` for the base (dark) theme.
- A theme = `{ id, name, tokens: Partial<Record<TokenName,string>>, css?: string }`
  applied to `:root` via a single `<style id="shrike-theme">`.
- Built-in: **Dusk (dark, default)**, **Midnight (OLED black)**, **Linen (light)**,
  **High Contrast**.
- Appearance settings: theme, accent colour (overrides `--shrike-accent*`,
  derived shades via OKLCH computations), message density (comfortable/compact),
  font scale (87.5–125%), UI zoom, saturation, reduced motion, show avatars
  in compact mode, 12/24h time.
- **QuickCSS**: live-editing textarea (monospace, tab-indent) injected last.
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
  indicator = small light dot (`--shrike-text-strong`) on the tile's top-left
  corner; mention count = red badge (`--shrike-danger-strong`) bottom-right.
  No left-edge pill: that is another product's trade dress.
- Separator, then **Spaces**: local, user-defined collections of Signal
  groups (and optionally DMs), shown as rounded-square tiles with emoji or
  initials, tinted with the space colour and filled with it on hover.
  Constant 14px radius (`--shrike-radius-tile`, no shape morph). Tooltip with
  name on hover (right side).
- Selected space: 2px `--shrike-accent` ring at a 3px offset from the tile.
  Accent is reserved for selection; keyboard focus is a dashed outline further
  out so the two never read alike.
- Drag to reorder; drag tile onto tile creates a **folder** (expand/collapse).
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
- Row hover shows a close/archive `×` (Home) or settings cog (Spaces).
- Right-click row (or Shift+F10 / ContextMenu key / Ctrl+Enter on a focused
  row): Mark as read, Mute ▸ (15m/1h/8h/24h/until I turn it back on),
  Pin/Unpin, Move to space ▸, Copy ID, Disappearing messages ▸, Archive.
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
for commands, `@` DMs only, `#` groups only). Empty query shows recent &
unread. Result rows show kind icon and space name. Enter opens, Shift+Enter
opens without closing? (no — keep simple).

### 4.9 Settings (full-screen overlay, Escape to close)
Left nav grouped: **User** (My Profile, Privacy), **App** (Appearance,
Accessibility, Notifications, Keybinds, Behaviour), **Shrike** (Plugins,
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
- Logo: `ShrikeMark` / `public/shrike.svg`, a shrike's head in profile built
  from straight cuts, with a short hooked beak and a bold mask stripe through
  the eye. In the app it is one colour (currentColor, mask knocked out); the
  favicon puts a pale head and black mask on a rufous tile. Reads at 16px.
- Default theme **Dusk**: graphite neutrals (cool grey, like the bird's
  plumage): rail `#101114`, sidebar `#15171b`, chat `#1b1d22`, elevated
  `#22252b`, floating `#0c0d10`, border `rgba(255,255,255,.06)`, text
  `#e6e8eb`, muted `#a2a5aa`, faint `#8d9096`. Accent rufous `#d4744a`
  (hover `#e58359`, active `#c06238`, dark `#1a0f0b` text on it), danger
  `#f0506e` (badge/button fills use `danger-strong` `#c93553` so white text
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
Plugins, Themes, QuickCSS, Connection (demo/signal-cli, URL, account, Test →
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

**Themes / QuickCSS.** `sanitizeUserCss` drops remote `@import` (http(s),
`//`, any `scheme://`; every syntax, case-insensitive) and reports remote
`url()` (kept, warned). The engine applies it to QuickCSS and theme CSS
whatever the caller does. Import/export `{ id?, name, kind?, tokens, css? }`:
only known token names (bare or `--shrike-` prefixed), string values that
can't break out of a declaration (`; { } < >` and comments refused), id
slugged from the name, built-in ids reserved, 200 kB file cap; stored themes
are re-validated (`toTheme`). Tokens left out keep Dusk's. Exporting a
built-in produces `<id>-copy`. QuickCSS: `CodeEditor` (gutter, Tab = two
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
