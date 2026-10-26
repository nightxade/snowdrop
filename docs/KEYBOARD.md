# Keyboard

Snowdrop is meant to be driven entirely from the keyboard. This page lists
everything: the default shortcuts (rebindable), the keys built into lists,
the composer and dialogs, and the optional **Vim mode** plugin.

`Mod` means **Ctrl** on Windows/Linux and **⌘** on macOS. Press
**Mod+/** at any time for the shortcut sheet; it reflects your own changes
(and Vim mode's keys while that plugin is on).

## Default shortcuts (rebindable)

Change or remove any of these in **Settings → Keybinds** (click a shortcut,
press the new keys; Esc or Tab cancels, Backspace or Delete removes it).

| Action                              | Keys                               |
| ----------------------------------- | ---------------------------------- |
| Quick switcher                      | Mod+K                              |
| New message                         | Mod+N (as in Signal Desktop)       |
| Previous / next conversation        | Alt+↑ / Alt+↓                      |
| Previous / next unread conversation | Alt+Shift+↑ / Alt+Shift+↓          |
| Mark conversation read              | Esc (when the composer is empty)   |
| Toggle member list                  | Mod+Shift+M                        |
| Settings                            | Mod+,                              |
| Search in conversation              | Mod+F                              |
| Search all chats                    | Mod+Shift+F                        |
| Jump to latest                      | Shift+PageDown                     |
| Keyboard shortcuts                  | Mod+/                              |
| Record a voice message              | Mod+Shift+Y (as in Signal Desktop) |

These have no default keys but are in the quick switcher (type `>`) and can
be bound in Settings → Keybinds: create a space, toggle compact mode, toggle
desktop notifications, open plugins / themes / appearance / keybinds,
**next / previous space**, **focus the composer**, **focus the message list**,
**open the command palette**, **sign out…** (also in the user panel's menu,
sidebar bottom-left, and Settings → Connection; docs/ENCRYPTION.md,
"Sign out"), and one **Theme: …** command per built-in theme (type `>theme`).

## Everywhere

- **Tab / Shift+Tab** move between regions; every list is a single tab stop.
- **Typing** a character while nothing text-like has focus starts a message
  in the composer (except with Vim mode on, where letters are commands).
- **Esc** closes the topmost menu, popover or dialog first; dialogs return
  focus to whatever opened them.
- **Shift+F10**, the **Menu** key or **Mod+Enter** opens the context menu of
  the focused item (conversation, space, message, member, category).

## Lists (rail, sidebar, member list)

| Keys                       | Action                                |
| -------------------------- | ------------------------------------- |
| ↑ / ↓                      | Previous / next item                  |
| Home / End                 | First / last item                     |
| Enter / Space              | Open / activate                       |
| Shift+F10, Menu, Mod+Enter | Item menu (move, mute, pin, archive…) |

## Message list

The list is one tab stop (the newest message by default).

| Keys                       | Action                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ↑ / ↓                      | Previous / next message (↑ at the top loads older history)                                                      |
| Enter                      | Step into the message: Tab then reaches its controls (hover bar first)                                          |
| Esc                        | Step back out of the message                                                                                    |
| R                          | Reply                                                                                                           |
| E                          | Edit (your own message)                                                                                         |
| + (or =)                   | Add a reaction                                                                                                  |
| Delete / Backspace         | Delete: for everyone on your own messages, for you on others' (asks first; hold **Shift** to skip the question) |
| Shift+F10, Menu, Mod+Enter | Message menu (copy, copy as Markdown, pin, …)                                                                   |

Clicking a quoted message (or Enter on it) jumps to the original and focuses it.

## Composer

| Keys                        | Action                                                          |
| --------------------------- | --------------------------------------------------------------- |
| Enter                       | Send (Shift+Enter: new line; swap them in Settings → Behaviour) |
| ↑ in an empty composer      | Edit your last message                                          |
| Esc                         | Close suggestions → cancel the reply → mark read (when empty)   |
| Esc (while recording)       | Cancel the voice message                                        |
| Mod+B / Mod+I / Mod+Shift+X | Bold / italic / strikethrough the selection                     |
| `@`, `:`, `/`               | Suggest members, emoji and slash commands                       |
| ↑ / ↓, Tab or Enter, Esc    | Move through / accept / dismiss suggestions                     |

Inline message editor: Enter saves (same send-key setting), Esc cancels.

## Quick switcher (Mod+K)

Type to search conversations, spaces and commands. Prefixes scope the
search: `>` commands, `@` direct messages, `#` groups, `*` spaces
(Backspace on an empty scoped query removes the scope). ↑ / ↓ move, Enter
opens, Esc closes.

## Search panel (Mod+F)

Enter opens the newest match; ↓ moves from the field into the results and
↑ / ↓ between them (↑ on the first goes back to the field); Esc closes.

## Search all chats (Mod+Shift+F)

Chats and people by name, then matching messages from every conversation
(history stored on this device). ↑ / ↓ move, Enter opens the chat or jumps to
the message, Esc closes. Signal Desktop puts this on Mod+F and the in-chat
search on Mod+Shift+F; Snowdrop keeps Mod+F for the open chat.

## Dialogs and other surfaces

- **Lightbox:** ← / → previous / next image, Esc closes.
- **Settings:** Esc closes; the search box filters every page.
- **Custom CSS editor:** Tab indents (two spaces), Shift+Tab outdents, Esc
  releases Tab so it moves focus again (the next Esc closes Settings).

---

## Vim mode

A built-in plugin, **off by default**. Turn it on in **Settings → Plugins →
Vim Mode** (or `>` in the quick switcher → _Open plugins_). A toast confirms
it once: _"Vim mode on — Esc for Normal mode, ? for keys"_.

Vim mode has two halves, each can be switched off in the plugin's settings:

1. **Navigation keys** — active whenever focus is _not_ in a text field
   (on the message list, a message, or nothing in particular) and from the
   composer's Normal mode for the app-level keys marked ◆ below. `i` `a` `I`
   `A` and `gi` also work from any other focusable control — a sidebar row,
   a rail tile, a header button — so you can always get to the composer.
2. **Modal editing in the composer** — Normal, Insert, Visual and Visual
   Line modes in the message box.

Opening a conversation — a sidebar click, `J`/`K`, `]u`/`[u`, `gt`/`gT`, the
switcher, a notification — always lands on the message list, never the
composer; the "Focus the message box when opening a conversation" setting
(Settings → Behaviour) is ignored. Use `i` `a` `I` `A` or `gi` to type.
Stepping from a focused sidebar row with `J`/`K` is the one exception: focus
follows to the new row instead, so you can keep stepping.

Counts work everywhere they make sense: `5j`, `3J`, `d2w`, `3x`, `2u`.
Multi-key sequences (`gg`, `]u`, `dd`, the leader) wait for the next key
for the _sequence timeout_ (default 1000 ms, adjustable); Esc clears them.
The keys typed so far show in the composer's mode pill, like Vim's showcmd.

### Navigation

| Keys                  | Action                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `j` / `k`             | Next / previous message (from outside the list, the first press lands on its tab stop: the newest message, or the last one you were on) |
| `gg` / `G`            | First loaded message (and load older) / latest message (jump to latest)                                                                 |
| `Ctrl+d` / `Ctrl+u` ◆ | Half a page down / up (focus follows)                                                                                                   |
| `Ctrl+e` / `Ctrl+y` ◆ | Scroll one line down / up                                                                                                               |
| `zz`                  | Centre the focused message                                                                                                              |
| `J` / `K`             | Next / previous conversation (as Alt+↓ / Alt+↑)                                                                                         |
| `]u` / `[u` ◆         | Next / previous unread conversation                                                                                                     |
| `gt` / `gT` ◆         | Next / previous space                                                                                                                   |
| `i` `a` `I` `A`       | Focus the composer in Insert mode (`A` at the end, `I` at the start)                                                                    |
| `gi`                  | "Go to insert": the composer, caret at the end of the draft — from anywhere, not just the list                                          |
| `Esc`                 | Clear a pending sequence (otherwise the usual Esc: close popovers, mark read)                                                           |

### Focused message

| Keys | Action                                                                    |
| ---- | ------------------------------------------------------------------------- |
| `r`  | Reply (the composer opens in Insert mode)                                 |
| `e`  | Edit (your own)                                                           |
| `+`  | React                                                                     |
| `o`  | Open the first image/video in the lightbox, or jump to the quoted message |
| `yy` | Copy text                                                                 |
| `Y`  | Copy as Markdown                                                          |
| `dd` | Delete (always through the confirm dialog)                                |
| `p`  | Pin / unpin (when the connection supports pins)                           |

### App

| Keys          | Action                                            |
| ------------- | ------------------------------------------------- |
| `/` ◆         | Search in conversation                            |
| `:` ◆         | Command palette (the quick switcher in `>` scope) |
| `?` ◆         | Keyboard shortcut sheet                           |
| `m`           | Toggle member list                                |
| `<leader>s` ◆ | Settings                                          |
| `<leader>k` ◆ | Quick switcher                                    |
| `<leader>n` ◆ | Toggle desktop notifications                      |
| `<leader>p` ◆ | Plugins                                           |

The **leader** is Space by default (Comma, Backslash or Semicolon in the
plugin settings). Space stays native (scrolling) when it isn't the leader.
Other unmapped letters do nothing while Vim mode is on.

### Composer

The composer starts in **Insert mode** (setting: _Start the composer in
Insert mode_, on by default), so typing works as usual: suggestions, IME,
spellcheck and native undo are untouched. **Esc** or **Ctrl+[** switches to
Normal mode.

- **Normal mode:** **Enter sends**. **Esc** runs the composer's own Escape:
  it cancels a reply first; on an empty draft it marks the conversation read
  **and returns focus to the message list** (in Vim mode that move belongs to
  Normal-mode Esc, so a first Esc in Insert mode never marks anything read).
- **Suggestions** (`@` `:` `/`) appear only in Insert mode. While the list is
  open it owns Esc and the arrows, so Esc closes it and keeps you in Insert.
- **Mode pill:** `INSERT` (quiet), `NORMAL` (accent), `VISUAL` / `V-LINE`
  (highlight), inside the field next to the emoji button. The field's
  accessible description is the current mode ("Vim: Normal mode"), so it is
  read with the field on focus; mode changes are also announced politely.
- **IME input outside Insert mode** (Japanese, Chinese, Korean…): starting a
  composition switches to Insert mode at the cursor first, so the composed
  text is inserted rather than replacing the character under the block
  cursor, and it is one undo step (repeatable with `.`).
- **Counts on app keys** (`5J`, `3]u`) run one after another, each waiting
  for the previous one to finish.
- **Block cursor:** Normal and Visual modes always show an accent block one
  character cell wide, with the character drawn in the on-accent colour. It
  stays a block where there's no character under it (an empty composer, a
  blank line, the end of a line in Visual mode): an empty cell is 1ch wide.
  Visual modes keep the selection highlight and put the block on the moving
  end. Insert mode gets the native thin caret back. While the composer is
  unfocused the block turns hollow. It blinks (solid while moving) unless
  reduced motion is on, then it stays solid. Clicking moves the cursor;
  dragging a selection in Normal mode enters Visual mode.

| Keys                            | Action                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `i` `a` `I` `A` `o` `O`         | Insert before / after / at line start / line end / new line below / above               |
| `h` `j` `k` `l`, arrows         | Left / down / up / right (`j`/`k` over logical lines; they stop at the first/last line) |
| `w` `b` `e` `W` `B` `E`         | Word motions (`W`… = whitespace-separated words)                                        |
| `0` `^` `$`                     | Line start / first non-blank / line end                                                 |
| `gg` `G`                        | First / last line (`3G`: line 3)                                                        |
| `f` `F` `t` `T` + char, `;` `,` | Find a character on the line, repeat / reverse                                          |
| `%`                             | Matching bracket                                                                        |
| `d` `c` `y` `>` `<` + motion    | Delete / change / yank / indent / outdent                                               |
| text objects                    | `iw aw iW aW i" a" i' a' i\` a\` i( a( ib i[ a[ i{ a{ iB i< a<`                         |
| `dd` `cc` `yy` `>>` `<<`        | Whole line(s)                                                                           |
| `D` `C` `Y`                     | Delete to end / change to end / yank line                                               |
| `x` `X` `s` `S` `r`char         | Delete char / char before, substitute char / line, replace                              |
| `~` `J`                         | Toggle case / join lines                                                                |
| `p` `P`                         | Put after / before                                                                      |
| `u` `Ctrl+r` `.`                | Undo / redo / repeat last change                                                        |
| `"+y`, `"*y`                    | Yank to the system clipboard too                                                        |
| `v` `V`                         | Visual / Visual Line mode                                                               |

**Visual mode:** motions and text objects extend the selection; `d` `x`
`c` `s` `y` delete / change / yank it, `>` `<` indent, `~` `u` `U` change
case, `r`char replaces, `J` joins, `p` replaces it with the register, `o`
jumps to the other end, `v` / `V` switch or leave, Esc leaves.

**Notes.** "Characters" are grapheme clusters: a ZWJ emoji family or a flag
is one character for `h` `l` `x` `r`. There is one unnamed register (shared
by `y` `d` `c` `x` `p`); it reaches the system clipboard only through `"+`
or `"*`. `u` uses Vim mode's own undo history (one step per change, a change
plus the text typed after it is one step); edits still go through the
browser, so native undo keeps working in Insert mode. Each conversation's
composer keeps its own mode and history for the session.

**Not supported:** Ex commands, search inside the draft (`/` opens the
conversation search instead), marks, macros, named registers (`"a` acts like
the unnamed one), Visual Block mode, `"+p` (paste with Ctrl+V in Insert
mode), rebinding individual Vim keys (the full list is read-only under
**Settings → From plugins → Vim keys**; the leader is configurable), and
Vim keys inside the inline message editor (it stays a normal text field).
