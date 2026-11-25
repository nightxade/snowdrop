# Decisions

This file lists the behaviour rules Snowdrop keeps, each with why it exists and the test that
fails if it stops being true. A rule here is something a user can see or feel: what the sidebar
shows while catching up, where focus goes after Esc, when a message may be edited. Internals
without a visible effect belong in [ARCHITECTURE.md](ARCHITECTURE.md), the shortcut list in
[KEYBOARD.md](KEYBOARD.md), and the build history in [PLAN.md](PLAN.md) §8.

## How to use it

- Change a rule only on purpose. When you do, update its entry and its test in the same commit, so
  the file keeps saying what the app does.
- Fixing a bug that breaks one of these rules means the test was missing or too weak. Fix the test
  first, see it fail, then fix the code.
- A new rule gets an entry with its test. An entry with no test says so (**Not pinned**) and what
  kind of test would pin it.
- Test paths are relative to `src/`, except those starting with `src-tauri/` or `journeys/`.

## How rules are pinned

- **Unit tests** (Vitest in happy-dom, and `cargo test` for `src-tauri`) pin the logic: stores,
  services, domain helpers and components against fakes. They are fast but have no layout, no real
  focus and no real input.
- **Journeys** (`journeys/test_*.py`, run with `npm run journeys`, see
  [ARCHITECTURE.md](ARCHITECTURE.md#journeys)) drive the production build in real WebKitGTK with
  real key, pointer and scroll events. A rule that depends on layout, scrolling, focus, timing or
  input should have a journey. Entries are written `journeys/<file>::<journey>`.

Entries are grouped by area: **S** sidebar, rail and switcher; **C** chat list and scrolling;
**M** message actions and keyboard; **P** composer; **N** notifications and catch-up; **D** media
and avatars; **T** settings, themes and appearance; **V** privacy, requests and phone sync; **H**
desktop shell and startup; **G** signal-cli patches and their wire rules; **R** data integrity.

---

## S. Sidebar, rail, spaces, switcher

### S1. Catch-up freeze

- **Rule**: While Snowdrop catches up with the server queue, the sidebar shows "Loading…" as every
  row's preview and holds row order and unread badges still, for the whole catch-up however long the
  pauses between messages. It updates all at once when catch-up ends. If the very first catch-up
  starts before any conversation has loaded, the order is frozen from the first conversations that
  load, not from an empty list. The hold belongs to the catch-up, not to the list on screen: when the
  sidebar moves into or out of the drawer (the window narrowed or widened) or a row is scrolled out
  and back, it still shows what it held, and nothing stays held once the catch-up ends. The hold is
  for what arrives live; what the user does here applies at once: Pin to top, Unpin, Archive,
  Unarchive and mute move a row to or from Pinned, or take it out of or back into the view, while
  recency order and badges stay held. A chat that comes back from the archive because something
  arrived in it stays held like any other arrival. The rail follows the same hold: a space's, a
  folder's and Home's tile do not light for what arrives while the held list shows nothing new, and
  light with it when the catch-up ends. Mark as read (a chat's menu, Mark all as read on a space or
  folder, the command, the new-messages bar) is the user's own action and applies at once: the
  chats marked have their held badges cleared immediately, on rows and rail alike, and what arrives
  in them afterwards is held like any other arrival.
- **Why**: Bug report: previews cycled through old messages on launch and again after waking from
  sleep; a mount during the catch-up took a new snapshot of the live order and badges. Own actions
  waiting for the end of the catch-up looked like they had not worked. The rail lit for chats the
  held list did not show.
- **Pinned by**: ui/features/sidebar/ConversationList.catchUp.test.tsx :: freezes order, badges and
  previews while catching up, then updates at once; freezes the order from the first conversations
  that load during the very first catch-up; ui/features/sidebar/ConversationList.collapsed.test.tsx ::
  holds still while catching up, then follows the live state; ui/features/sidebar/
  ConversationList.catchUp.test.tsx :: keeps the freeze when the list is unmounted and mounted again
  during the catch-up; journeys/test_catch_up.py :: catch_up_holds_the_sidebar (bursts, pauses, no
  caught-up for over 20 s); journeys/test_catch_up.py :: catch_up_keeps_the_order;
  journeys/test_catch_up.py :: catch_up_hold_survives_a_narrow_round_trip;
  ui/features/sidebar/ConversationList.catchUp.test.tsx :: applies what the user does here at once
  while catching up, and holds what arrives; journeys/test_sidebar.py ::
  archiving_a_chat_while_catching_up_takes_effect_at_once;
  ui/features/rail/useUnread.catchUp.test.tsx (both); core/stores/session.test.ts :: badges held for
  a catch-up; journeys/test_catch_up.py ::
  rail_tile_stays_dark_while_the_catch_up_holds_a_new_message,
  mark_as_read_during_the_catch_up_clears_the_held_badge_at_once.

### S2. One catch-up tracker for the sidebar and the notification hold

- **Rule**: A single tracker sets both the sidebar freeze (`session.catchingUp`) and the notification
  hold (`session.notificationsHeld`), so they start and end together. A catch-up ends on the
  backend's `caughtUp` (queued behind earlier messages), or after a quiet period when the backend
  cannot say, or at a ceiling: about 20 s, or 2 minutes with a backend that sends `catchingUp`. A
  failed start cannot leave the sidebar stuck on "Loading…".
- **Why**: Bug report: two trackers let the sidebar unfreeze mid-drain while notifications were still
  held, and previews cycled again.
- **Pinned by**: core/services/catchUp.test.ts :: with the capability the sidebar and the hold both
  last past the short ceiling, up to the long one; a capable backend that goes offline and comes back
  also gets the long ceiling, sidebar included; without the capability both end at the same short
  ceiling, as before; is strict, with the long ceiling, on a build that orders catchingUp, though the
  version is only known after connecting; core/services/CatchUpTracker.test.ts :: ends on the backend
  caught-up signal; falls back to a quiet period when the backend never reports caught-up; a hard
  ceiling ends it even with a steady stream of messages; app/createSnowdrop.faulty.test.ts :: ends
  catching up only after every message delivered before caughtUp is stored; core/services/
  services.test.ts :: reports failed initial sync as an error state.
- **Not pinned**: the flags being cleared when a failed start disposes the tracker (only a code
  comment in `SyncService.disposeCatchUp`); a unit test of `SyncService.disposeCatchUp` would pin it.

### S3. History import stays out of the sidebar

- **Rule**: The background history import pauses while catching up and never touches notifications or
  the sidebar.
- **Why**: The import must not cause sidebar churn or notifications for old messages.
- **Pinned by**: core/services/historyImport.test.ts :: pauses while catching up and resumes once it
  clears; does not touch stores other than session (no notifications, no sidebar churn).

### S4. Combined Home list by default

- **Rule**: Direct messages and groups share one "Conversations" section. Settings > Appearance >
  "Separate groups and direct messages" restores the split layout.
- **Why**: User request: both lists stay in view however long either gets.
- **Pinned by**: ui/features/sidebar/model.test.ts :: by default lists DMs and groups together, pinned
  first, each by recency; splits DMs and groups, each pinned first, keeping recency order and
  skipping archived.

### S5. Pinned rows lead their section

- **Rule**: There is no separate Pinned section. Pinned rows sit first in their section (a space's
  category too, in the category's own order among themselves), stay visible when the section is
  collapsed, and carry a small pin icon that is announced as pinned.
- **Why**: User request.
- **Pinned by**: ui/features/sidebar/model.test.ts :: also shows the pinned rows of a collapsed
  section, even unselected and read; leads each category with its pinned rows, which stay visible
  when it is collapsed (S5); journeys/test_sidebar.py :: pinned_row_stays_when_its_category_collapses.
- **Not pinned**: the pin icon and its screen-reader announcement; a component test on the row would
  pin them.

### S6. A collapsed section shows what its badges count

- **Rule**: A collapsed section still shows the open chat, unread rows, marked-unread rows and muted
  rows that mention you; muted unread rows hide. One attention rule (`attentionOf`) drives row dots,
  collapsed sections, the switcher's space dot and mark-all-read.
- **Why**: Bug report: collapsed sections hid what the badge counted.
- **Pinned by**: ui/features/sidebar/model.test.ts :: shows the open and unread rows of a collapsed
  section only; keeps in step with the row: a muted unread row hides, a marked-unread one and a muted
  mention show; ui/features/sidebar/ConversationList.collapsed.test.tsx :: follows the row: muted
  unread hides, marked unread and muted mentions show; core/stores/views.test.ts :: gives a muted chat
  no count and no dot, but keeps its mentions.

### S7. Unread totals

- **Rule**: Muted chats add only their mentions; a chat marked unread counts as one (unless something
  in it is already unread); archived chats add nothing. The same total feeds the badge, the rail and
  the tray.
- **Why**: Signal parity and user request.
- **Pinned by**: core/stores/views.test.ts :: adds up what the rows show: muted adds mentions only,
  marked adds one, archived nothing; core/stores/conversations.test.ts :: counts nothing for an
  archived chat; counts a chat marked unread as one only when nothing in it is unread.

### S8. Mark as unread

- **Rule**: "Mark as unread" is in the conversation menu and the command palette. It is local only
  and sends nothing; opening the chat or marking it read clears it. On the open chat it holds until
  the reader interacts with that chat (the first scroll, key, typing or press inside it,
  `useReleaseMarkedUnread`) or reopens it: a message that arrives meanwhile does not clear it and is
  not auto-read (`SyncService.isViewing`, `useReadTracking`); once the hold ends, what arrived is read.
- **Why**: Signal Desktop parity; bug report (an arriving message cleared it at once).
- **Pinned by**: app/markUnread.test.tsx :: shows one menu item, whichever applies, flags the row and
  sends nothing; is cleared by opening the chat, and stays while the chat is open until it is
  reopened; lights the rail tile of its space; core/services/services.test.ts :: does not auto-read a
  chat the user marked unread, while it is open; ui/features/chat/useReleaseMarkedUnread.test.tsx;
  journeys/test_list.py :: marked_unread_open_chat_holds_until_the_reader_interacts,
  marked_unread_open_chat_is_cleared_by_reopening_it.

### S9. Mark all read covers archived chats

- **Rule**: Mark all read in a space also clears archived chats; the menu item is offered only when a
  chat that counts is unread.
- **Why**: Signal Desktop parity.
- **Pinned by**: ui/features/spaces/markSpaceRead.test.tsx :: clears every unread chat, archived ones
  too as Signal Desktop does, but is only offered for chats that count.

### S10. Archive

- **Rule**: An "Archived chats" entry at the bottom of each list opens that space's archive, with a
  way back (the entry takes focus again). Archiving unpins; a new message unarchives (pinned or
  muted or not; a read-state change or a system line does not). Archived chats add nothing to counts.
  Archive is local only, as signal-cli cannot write it. Chats archived on the phone start archived
  here unless Snowdrop already has local state for them.
- **Why**: Signal Desktop parity; the phone-archive rule came from a bug report.
- **Pinned by**: ui/features/sidebar/ConversationList.archive.test.tsx (all six); core/services/
  services.test.ts :: a new message brings an archived chat back to the list, pinned or muted or not;
  read state and system lines do not; seeds the phone archived flag for a conversation with no local
  state yet; never overrides local state already set for a conversation archived on the phone;
  core/stores/local.test.ts :: archiving unpins, pinning unarchives, and new activity unarchives only
  an archived chat.

### S11. Which chats are listed

- **Rule**: Only chats with a real message are listed, as on the phone. A profile-sharing contact
  with no messages gets no empty DM; history chats holding only system entries (joined Signal, safety
  number, profile changes) are not listed; system lines never create or raise a chat; stale empty
  direct chats from the old rule are dropped except those that are open or have history-only
  messages.
- **Why**: Bug report: empty DMs appeared for people who only shared a group.
- **Pinned by**: core/backend/signal-cli/SignalCliBackend.test.ts :: never lists an empty
  profileSharing contact as a DM, however it got that flag; lists self, contacts and groups, and only
  shows a DM once it has activity; a timer change alone never announces (or lists) a DM with no other
  activity; core/services/ConversationDirectory.test.ts (all); core/services/services.test.ts ::
  drops an empty direct conversation, unless its messages are only in history or it is open;
  core/backend/signal-cli/history/archive.test.ts :: answers chatLatestMessageAt with undefined for a
  chat with only system entries.

### S12. Chat order

- **Rule**: Chats sort by the newest real message's sent time (live or history archive, whichever is
  later). History chats no longer sort at 0; decrypt failures, timer changes and other system lines
  do not raise a chat.
- **Why**: Bug report: history chats sat at the bottom.
- **Pinned by**: core/backend/signal-cli/history/archive.test.ts :: answers chatLatestMessageAt with
  the newest real message's own dateSent, skipping a newer system entry; core/stores/
  conversations.test.ts :: keeps the newest activity when the backend re-sends a conversation.

### S13. Sidebar preview content

- **Rule**: A preview is one line: author prefix in groups, "You" for your own messages, a poll's
  question with the chart marker, labels for stickers, attachments, deleted messages and system
  lines. Spoilers are never revealed in a preview, a screen-reader announcement, a reply quote or a
  notification.
- **Why**: Bug report: spoilers leaked into the preview, the announcer and quotes.
- **Pinned by**: ui/features/conversation/preview.test.ts (all five); ui/features/chat/list/
  LiveAnnouncer.test.tsx :: never reads a spoiler aloud; ui/features/chat/message/QuoteHeader.test.tsx
  :: never reveals a spoiler in the quoted text; core/services/NotificationService.test.ts :: hides
  text when previews are off and never reveals spoilers.
- **Not pinned**: that the preview, notifications, announcer and quotes use one wording (see Shared
  logic: they do not share one function); a table test over all four would pin it.

### S14. Preview fallback after removal

- **Rule**: When the previewed message is deleted, expires or is purged, the next newest takes over
  (or the preview clears). A preview that has already moved on is untouched.
- **Why**: Bug report.
- **Pinned by**: core/services/eventPipeline.test.ts :: falls back when the newest message expires;
  falls back, then empties, as the newest messages are deleted for me; leaves the preview alone when
  a message other than the newest goes. A delete for me synced from the phone also refreshes the
  preview: core/services/deleteSync.test.ts :: removes a named message from the window, the repository
  and the sidebar preview.

### S15. Preview around your own send

- **Rule**: A sync echo of an in-flight send does not take the preview. After a reply arrives during
  a send the preview does not go back to your older message; a settled send hands the preview to the
  stored newest; a message sent from the phone still moves it.
- **Why**: Bug report: the preview jumped back to the user's own message.
- **Pinned by**: core/services/sidebarPreviewOrder.test.ts (all four).

### S15a. Preview follows your own edits and deletes

- **Rule**: Editing or deleting for everyone the previewed message updates the preview at once, as
  an incoming edit or delete does; a failed edit or delete that reverts the message reverts the
  preview too, but only while it is still that message. Editing an older message leaves the preview
  alone. Every operation on a message (reaction, pin, vote) goes through the same step; only edits
  and deletes change what `previewText` shows.
- **Why**: Bug report: after your own edit or delete the preview kept the old text until restart.
- **Pinned by**: core/services/sidebarPreviewOwnOps.test.ts (all five: edit and delete with their
  rollbacks, an older message, a preview that moved on, an edit from the user's other device);
  journeys/test_sidebar.py :: sidebar_preview_follows_an_edit and
  sidebar_preview_follows_a_delete_for_everyone.

### S16. Previews that are not messages

- **Rule**: Message-request answers and profile-name lines never become a chat's preview, live or
  after a relaunch. A pin line may.
- **Why**: Signal Desktop parity.
- **Pinned by**: core/services/timelineLines.test.ts :: keeps a request answer from becoming the
  preview, live and after a relaunch; keeps a profile-name line from becoming the preview; lets a pin
  line be the preview.

### S17. Message request rows

- **Rule**: A request row reads "Message request" instead of its preview; once accepted it shows the
  real preview; a blocked request shows "Blocked".
- **Why**: Signal parity.
- **Pinned by**: ui/features/sidebar/ConversationRow.request.test.tsx (both).

### S18. Keyboard row navigation

- **Rule**: Alt+Up/Down walks the rendered sidebar rows (clamped at the ends); in the Archived chats
  view those are the archive's rows. Alt+Shift+Up/Down walks
  Home, then spaces in rail order, wrapping and switching space, stopping only at unread, non-muted
  (or mentioning) chats. Focus follows.
- **Why**: User request (keyboard-first).
- **Pinned by**: ui/features/sidebar/model.test.ts :: walks exactly the rendered rows and clamps at
  the ends; orders Home first, then spaces in rail order; wraps around, skips the current one and
  switches spaces; muted conversations only count when they mention you; test/shell.test.tsx ::
  Alt+↓ and Alt+Shift+↓ from the composer land on the new message list; Alt+↓ from a sidebar row moves
  focus to the next row; app/App.test.tsx :: navigates by keyboard; ui/hooks/focusTargets.test.ts ::
  the "while the new view settles" tests (lands on the list once it exists, upgrading from the
  sidebar row; never taken from an input, a dialog or a trigger the user is still typing in; bounded
  frames); journeys/test_keyboard.py :: alt_arrow_from_the_composer_into_a_new_chat,
  alt_arrow_into_a_slow_loading_chat (a 2.5 s load); ui/features/sidebar/ConversationList.archive.
  test.tsx :: Alt+Up/Down walk the archive rows while the archive is open, the list rows again after;
  journeys/test_sidebar.py :: archive_list_alt_arrows_stay_on_the_rows_shown. A list that remounts
  after the keys landed (see C11) hands focus on itself, so a slow load is covered.

### S19. Clicked conversation rows take focus (WebKitGTK)

- **Rule**: Clicking a row focuses it. In Vim mode, opening a conversation retries focus for a few
  frames while the list mounts and only targets rows inside the message scroller.
- **Why**: Bug: WebKitGTK does not focus an element on click.
- **Pinned by**: ui/hooks/focusTargets.test.ts :: retries a few frames before falling back, when the
  list has not rendered a row yet; a pointer open moves focus to the list once a policy is active;
  ui/features/sidebar/ConversationRow.focus.test.tsx (a click event leaves focus alone, as in
  WebKitGTK, and the row still ends up focused); journeys/test_sidebar.py ::
  arrow_keys_step_from_the_clicked_row (after a click, Down steps from that row).
- **Not pinned**: a real WebKitGTK click that leaves a button unfocused. The journey runner's
  synthetic click focuses buttons itself, so no journey can see the missing `focus()` call; the unit
  test does.

### S20. Narrow-window navigation

- **Rule**: Below 760 px the navigation is a drawer, open until a conversation is picked; picking the
  conversation that is already open closes it; focus then goes to the message list as opening by
  keyboard does (the composer with "Focus the message box…" on, T7), not back to the menu button
  (`Drawer`'s `closeTarget`). A window narrowed while focus is on a sidebar row (the drawer is closed
  and the row leaves) hands focus to the fallback, the composer (M15). Widening the window past 760 px closes it, so
  narrowing again never brings it back over the chat. Below 1100 px the member list is an overlay sheet
  that Esc closes. Every breakpoint (760 and 1100 here, and the smaller ones in the stylesheets) is
  measured on the page as laid out, so it follows Zoom: at 150% a 1000 px window counts as 667 px.
  The stylesheets ask this with root attributes (`:root[data-below-760]`, one per breakpoint, set by
  `useBreakpointAttributes` from the same window-limit-times-zoom queries; not `@container`, whose
  container on `body` changed how WebKit lays out the message list and so where a chat opens), the
  code with `belowBreakpoint` / `useBelowBreakpoint`; at 100% both equal the old window-width rules. The search text typed in the chat's search panel stays when it moves
  between the page and a sheet at either breakpoint.
- **Why**: Responsive rules from the plan, plus bug reports (re-picking the open chat left the
  drawer up; at 150% zoom the wide layout was used in a window too narrow for it, so header buttons
  ran out of the window; narrowing the window emptied the search field).
- **Pinned by**: test/shell.test.tsx :: puts navigation in a drawer below 760px, open until a
  conversation is picked; navigation drawer: tapping the conversation that is already open closes it;
  navigation drawer across resizes (all); shows the member list as a modal sheet below 1100px;
  journeys/test_sidebar.py :: navigation_drawer_does_not_come_back_on_narrowing,
  search_text_survives_narrowing_below_1100, search_text_survives_narrowing_below_760;
  test/shell.test.tsx :: breakpoints follow the Zoom setting; ui/hooks/useMediaQuery.test.tsx ::
  belowBreakpoint; journeys/test_list.py :: scrolling_up_loads_older_messages_without_a_jump (a container on body broke it); ui/features/chat/SearchSlot.test.tsx (all); journeys/test_appearance.py ::
  zoomed_header_buttons_stay_inside_the_window; journeys/test_sidebar.py ::
  drawer_pick_lands_on_the_message_list, drawer_pick_lands_on_the_composer_when_that_is_the_setting,
  narrowing_hides_the_focused_sidebar_row_and_focus_goes_to_the_composer.
- **Not pinned**: the stylesheets' `data-below-*` rules themselves (only the 760 px rules show in the
  zoom journey); a drawer left open while zooming.

### S21. Quick switcher

- **Rule**: Mod+K opens it. Prefixes: `>` commands, `@` DMs, `#` groups, `*` spaces. An empty query
  shows unread chats (mentions first) then recent ones. Archived chats are findable but rank after
  live ones of equal score and are hidden from empty lists; weak tail matches (under 40% of the best)
  are dropped. Enter opens the chat and focuses the message list (it stays there when the list
  remounts as the chat's messages load, see C11); Escape returns focus.
- **Why**: User request; archived search added later.
- **Pinned by**: ui/features/switcher/model.test.ts (all); test/shell.test.tsx :: highlights matches,
  opens with Enter and focuses the message list; returns focus to where it was when dismissed;
  journeys/test_keyboard.py :: switcher_enter_into_a_new_chat, switcher_enter_into_a_slow_loading_chat.

### S22. Spaces and the rail

- **Rule**: Spaces are per-account local state: the demo's seeded spaces never appear in a real
  account; a chat lives in at most one space; DMs show in Home even when assigned, groups only when
  unassigned; deleting a space returns its chats to Home; a space the user deleted is not
  re-seeded. Dragging onto a tile merges into a folder only over the middle half. Dropping a chat
  on the tile of the space it is already in changes nothing (it keeps its category, no toast), and
  a chat already in Home dropped on Home likewise. A conversation that is deleted (on the phone, or
  as a message request) loses its space and category with it, so the counts a space tells the user
  (Delete space, the checklist) match what it lists, and a group that messages again starts in Home,
  not in its old space. Moving a chat out of a space and back puts it at the end of the first
  category.
- **Why**: Bug report: demo spaces showed in a real account. A drop on the chat's own space sent it
  to the first category; a space counted chats the phone had deleted.
- **Pinned by**: app/createSnowdrop.signalCli.test.ts :: never shows the demo’s seeded spaces under a
  signal-cli scope; app/createSnowdrop.test.ts :: does not re-seed spaces the user deleted;
  core/stores/spaces.test.ts and spaces.p4.test.ts; ui/features/rail/railDrop.test.ts;
  app/dataScope.test.ts; core/services/messageRequests.test.ts :: delete drops where the chat was
  filed, so a group that comes back starts in Home; journeys/test_sidebar.py ::
  dropping_a_chat_on_its_own_space_leaves_it_in_its_category,
  dropping_a_group_on_home_while_already_in_home_does_nothing,
  delete_space_dialog_counts_only_the_chats_it_has.
- **Not pinned**: the space menu's Move up / Move down for keyboard reordering; a component test of
  the menu would pin it.

### S23. Space tiles show unread and mention indicators

- **Rule**: Space tiles show unread and mention indicators; muting a space keeps mentions only.
- **Why**: Plan (spaces).
- **Pinned by**: app/App.test.tsx :: shows unread and mention indicators on space tiles; muting keeps
  mentions only; ui/features/switcher/model.test.ts :: shows only mentions for a muted space, as the
  rail does.

### S24. Sidebar footer and skeleton

- **Rule**: The sidebar footer shows an unobtrusive progress indicator while history imports; list
  skeleton shimmer pauses while off screen.
- **Why**: Visible import progress; an idle-CPU bug (shimmer running off screen).
- **Pinned by**: ui/features/sidebar/UserPanel.test.tsx (three); ui/features/sidebar/
  ListSkeleton.test.tsx :: marks the shimmer off while not intersecting; ui/features/chat/list/
  HistorySkeleton.test.tsx.

### S25. The open chat and its space

- **Rule**: A chat opens in the space it lives in (Home for a direct chat and an unfiled group): from
  the Mentions inbox as from search, the switcher and a notification, and a new group, which lives in
  Home, opens in Home even when it was made while a space was shown. The open chat stays open when it
  is moved to another space or taken out of its space (the pane keeps showing it where the user is),
  and going to the space it now lives in (or Home) shows it selected there, not "Pick a
  conversation". Deleting the space that is shown keeps its open chat open, now in Home and selected.
- **Why**: The Mentions inbox opened a chat in a space that does not list it; a moved chat was gone
  from the pane's list and its new space showed nothing open.
- **Pinned by**: app/openChatFollowsSpace.test.ts (all three); journeys/test_sidebar.py ::
  mention_from_the_inbox_opens_the_chat_in_its_space,
  moving_the_open_chat_to_a_space_keeps_it_open_and_selected_there,
  deleting_the_viewed_space_keeps_its_open_chat_open_in_home; journeys/test_dialogs.py ::
  new_group_made_inside_a_space_opens_in_home.

---

## C. Chat list and scrolling

### C1. Follow slack

- **Rule**: A reader within half the list's visible height (at least 120 px) of the bottom follows a
  new message; one further up is never moved. The pin and the at-bottom threshold share that slack.
- **Why**: Bug reports: the chat did not follow; then "within one short message" was too tight.
- **Pinned by**: ui/features/chat/list/bottomPin.test.ts :: the slack is half the visible height, and
  never less than the minimum; a reader up to half a page away keeps following; past it, never moved;
  the slack boundary: at it the new message is followed, one px beyond it is not; journeys/
  test_scrolling.py :: receive_while_scrolled_up (scrolled well up: the view does not move; at the
  bottom: new messages are followed); journeys/test_list.py :: follow_boundary_is_half_a_page (10 px
  inside half the list's height: followed; 10 px outside: the view and the jump pill stay put).

### C2. Follow survives the list's own smooth scroll

- **Rule**: While the list follows, only the reader scrolling up releases the pin. The list's own
  smooth scroll never does, so later messages keep following.
- **Why**: Bug report: the chat stopped following after a message.
- **Pinned by**: ui/features/chat/list/bottomPin.test.ts :: the list's own scrolling does not release
  the pin, however far the new row put the bottom; the reader scrolling up during a follow takes the
  pin away; a long jump up right after a follow began still releases the pin.
- **Not pinned**: the real smooth scroll, and no journey can pin it. In the journey runner's
  WebKitGTK the list's own scroll to a new row happens in one step (the instant re-pin follows the
  new height before any animation), so no scroll event ever lands beyond the slack during a follow,
  even for a row taller than half the list or a burst of them; breaking the guard in
  `BottomPin.onScroll` leaves every journey green. The follow itself is pinned by
  journeys/test_scrolling.py :: receive_while_scrolled_up (arrivals at the bottom are followed).

### C3. Your own send scrolls into view at once

- **Rule**: A message you send scrolls into view when its pending row appears, not after the network
  send, and does not scroll again when the row settles. A list detached from the present is left
  alone (the composer jumps to the present first).
- **Why**: Bug report.
- **Pinned by**: ui/features/chat/list/useFollowOwnSend.test.tsx (all); core/services/races.test.ts
  :: jumpToPresent during loadOlder still re-anchors, so a send is visible; journeys/test_send.py ::
  send_a_message (the sent message lands in view and the composer keeps focus).

### C4. Jump pill

- **Rule**: "Jump to latest" shows as soon as someone else's message arrives below a scrolled-up
  reader, never for your own send, never at the bottom, and hides on reaching the bottom or on a jump.
- **Why**: User request.
- **Pinned by**: ui/features/chat/list/useArrivalsBelow.test.tsx (all eight); journeys/
  test_scrolling.py :: receive_while_scrolled_up.
- **Not pinned**: the label wording; a component test would pin it.

### C5. Bottom pin while rows settle

- **Rule**: A list opened at the bottom stays pinned while images and fonts settle; one opened at the
  unread divider or a jump target does not, even when its end lies within the follow slack: until the
  reader moves it (wheel, touch, a key in the list, its scroll bar), reaches the very bottom or jumps
  there, it is held where it opened, and is not "at the bottom" for read tracking either (C7). A list
  held at the divider also requests no older page (C6) until it is released: the divider is the first
  row of the loaded unread run, so an older page moves it, and putting the view back on it by
  scrolling lands wherever the unmeasured rows above happen to settle. It re-pins when the composer
  grows only if it was holding the bottom.
- **Why**: Plan (the newest message half hidden).
- **Pinned by**: ui/features/chat/list/bottomPin.test.ts :: a list opened at the bottom holds it while
  rows settle; a list opened at the unread divider or a jump target does not; opened at the divider
  with its end within the slack: settling rows do not pin it; a reader released from the divider
  within the slack follows again; a list held at the divider is released by reaching the very bottom,
  or by a jump there; re-pins when the composer grows only if it was holding the bottom; ui/features/
  chat/list/MessageListWiring.test.tsx :: reports the reader moving the list; journeys/test_list.py ::
  opened_at_the_bottom_stays_there (the newest row grows after it was measured, and the composer
  grows under the list: the end stays in view), opened_at_the_unread_divider_is_not_pulled_down (rows
  settling and a row below growing: the view stays at the divider, the messages stay unread);
  opened_at_the_unread_divider_stays_when_older_history_loads, ..._stays_with_compact_rows,
  opened_at_a_short_unread_run_stays_when_older_history_loads (the chat stays at its divider while
  the older page waits, and scrolling up then loads it); ui/features/chat/list/prefetch.test.ts ::
  defers the older page, rather than requesting it, while the list is held at the unread divider.
- **Not pinned**: a late-loading image itself. Demo images reserve their box from the attachment's
  size, so nothing settles late by itself; the journeys grow a row from the page instead. A composer
  growing while the reader is scrolled up (not holding the bottom) has no journey.

### C6. History prefetch

- **Rule**: Older pages (and, after a jump, newer ones) load when the rendered range is within 24
  rows of the loaded window's edge, not at the literal edge; never once history has run out or the
  window is anchored to the present.
- **Why**: Scroll stalls the user noticed.
- **Pinned by**: ui/features/chat/list/prefetch.test.ts (all six); ui/features/chat/list/
  MessageList.test.tsx :: requests the next page before the reader reaches the physical top,
  coalescing repeat triggers; journeys/test_list.py ::
  scrolling_up_loads_older_messages_without_a_jump (a 400-message history, three pages: each loads
  while the reader is still a screen or two from the top, and the message being read does not move
  when it arrives).
- **Not pinned**: loading newer pages after a jump (`loadNewer`) in real scrolling.

### C7. Read tracking

- **Rule**: A chat is marked read only while its bottom is visible and the window is focused;
  arrivals while scrolled up stay unread. Within the follow slack of the end (C1) is close enough to
  auto-read an arrival, which is followed into view, but messages that are already unread wait until
  the newest message is wholly on screen (a reader who scrolled up and came back part of the way, or
  Esc from the composer scrolling a row into view, has not seen them). That is measured on the
  newest row, not the scroll end: the list's footer and the TUI shell's padding are not messages,
  and the list's own scroll to the end can stop short of them. A reaction or vote on your own
  message counts as news that is read only when the chat is on screen, and it too waits until the
  newest message is on screen.
- **Why**: Signal parity; plan.
- **Pinned by**: ui/features/chat/list/useReadTracking.test.tsx (all six); ui/features/chat/message/
  useHistoryRead.test.tsx :: waits for both focus and actual intersection, and ignores stale observer
  callbacks; ui/features/chat/list/useReadTracking.test.tsx :: waits for the newest message to be on
  screen, not just within the follow slack of the end; journeys/test_scrolling.py ::
  scrolled_part_way_back_stays_unread, arrivals_while_the_window_is_away_stay_unread (real window
  focus events); journeys/test_appearance.py :: tui_opening_an_unread_chat_reads_it.
- **Not pinned**: real IntersectionObserver for history pages (useHistoryRead).

### C8. Unread divider and "N new messages" bar

- **Rule**: The divider sits before the first unread message from others, ordered by arrival, not by
  the sender's clock. It is snapshotted when the chat opens, so later auto-read does not move it.
- **Why**: Plan (chat list behaviours).
- **Pinned by**: core/domain/groupMessages.test.ts :: places the new-messages divider before the first
  unread from others; orders the new-messages divider by arrival (seq), not the sender clock;
  core/services/services.test.ts :: snapshots the unread marker on open; ui/features/chat/list/
  MessageListHooks.test.tsx :: reports a divider above the rendered range when its row is not mounted;
  ui/features/chat/lib/lib.test.ts :: counts a list sharing only a floating item as replaced (the
  divider moves with the loaded unread run, so it never anchors the list); journeys/test_list.py ::
  opened_at_the_unread_divider_stays_when_older_history_loads (C5).
- **Not pinned**: the bar jumping to the divider, and "Mark as read" keeping the divider; a component
  test of the bar would pin them.

### C9. Message grouping

- **Rule**: Consecutive messages from one author within 7 minutes group; day dividers and system
  messages break groups; replies get a full header.
- **Why**: Plan (message layout).
- **Pinned by**: core/domain/groupMessages.test.ts (all).

### C10. Ordering by arrival

- **Rule**: Messages are ordered by local arrival sequence, never by the sender's timestamp.
- **Why**: Bug: skewed sender clocks buried messages.
- **Pinned by**: core/stores/messages.test.ts :: orders by seq across pages and live appends;
  core/domain/groupMessages.test.ts :: orders the new-messages divider by arrival (seq), not the
  sender clock; core/stores/conversations.test.ts :: counts a message from a sender with a skewed
  clock.
- **Not pinned**: backfilled history taking sequence numbers below everything stored; a
  `messages` store test with a backfilled page would pin it.

### C11. The tab stop follows the newest message

- **Rule**: The list is one tab stop. It is the newest message when the chat opens and follows newer
  messages until the user moves it, never while that row has focus. Leaving the composer with Esc
  lands on the newest message, not a row that has scrolled away. When a sent message replaces its
  pending row, the tab stop and focus move to the sent row, so Esc right after Enter still works;
  the row itself stays on the page through the swap (a row asked for an id the store has just
  dropped keeps showing the last message), so focus never falls to the page, not even for a frame.
  The same when the list remounts because its window was replaced (messages arriving in a chat that
  had none, a jump outside the window, a reload): if focus was in the list (a row or the scroller)
  and falls to the page, it goes to the new current row, else the scroller, for about 20 frames
  counted from the remount, and never when focus is anywhere else.
- **Why**: Bug reports: Esc from the composer scrolled then snapped back; Esc right after sending
  selected nothing; Alt+Up/Down or the switcher into a chat whose messages loaded late left focus on
  the page.
- **Pinned by**: ui/features/chat/list/MessageList.test.tsx :: an untouched tab stop follows new
  messages, so focus() lands on the newest; a tab stop the user moved stays put when a new message
  arrives; the focused newest row keeps its marker when a new message arrives; focusLatest() always
  lands on the newest message and scrolls it into view; ui/features/chat/list/
  MessageList.sendSwap.test.tsx :: keeps the tab stop and focus on the message when its id changes;
  ui/features/chat/message/MessageItem.swap.test.tsx :: stays on the page with its focus until it is
  given the new id;
  ui/features/chat/list/MessageList.remountFocus.test.tsx (focus follows a remount long after the
  list opened; not taken from another field); journeys/test_keyboard.py ::
  alt_arrow_into_a_slow_loading_chat;
  ui/plugins/vim/vim.integration.test.tsx :: returns to the newest message, not wherever the list was
  last left, when leaving an empty composer; journeys/test_keyboard.py :: esc_from_the_composer;
  journeys/test_keyboard.py :: esc_right_after_sending.

### C12. Current-message marker

- **Rule**: The keyboard or Vim current message carries a visible marker (`data-current`), safe in
  WebKitGTK (not `:focus-visible`), and the marker is on the right row, not the previous one.
- **Why**: Bug: WebKitGTK does not show `:focus-visible` on programmatic focus.
- **Pinned by**: ui/plugins/vim/vim.integration.test.tsx :: marks the current row with a stable
  data-current attribute, not the previous one; journeys/test_keyboard.py :: esc_from_the_composer
  (checks `data-current` on the focused row, stays put, arrows move it), current_message_is_painted
  (the current row's computed accent bar and background, moving with the arrows, and a row focused by
  a mouse click, which is not `:focus-visible`, paints too).
- **Not pinned**: how the marker looks to the eye (a screenshot comparison would). In the runner's
  WebKitGTK 2.54 a script-focused row after a key does match `:focus-visible`, so only the
  click-focused row shows the original bug.

### C13. Hover and flash are exclusive across the list

- **Rule**: A row scrolled out from under a still pointer never leaves a stale hover. Keyboard focus
  also activates a row; a mouse click inside does not. The keyboard highlight goes out as soon as
  focus turns up anywhere else, even when WebKitGTK moved it off the row without a blur (a resize).
- **Why**: Plan bug (stale hover after scrolling).
- **Pinned by**: journeys/test_list.py :: hover_follows_a_pointer_the_list_scrolls_under (a still
  pointer, real wheel, then the hovered row carried out of the rendered range and back: one hover bar,
  on the row under the pointer), one_row_flashes_after_a_jump (a second quote click moves the flash:
  never two rows); ui/features/chat/message/
  MessageItem.focusLoss.test.tsx :: goes out when focus turns up elsewhere without the row being
  blurred.
- **Not pinned**: no unit test drives `rowState`. WebKitGTK sends the leave of a row that scrolls out
  from under the pointer, so the per-row flags this replaced are only caught once the row leaves the
  page and returns.

### C14. Jump to a quoted, pinned or found message

- **Rule**: Clicking a quote (or Enter on it) jumps to and focuses the original, and says so when it
  isn't stored locally. A second quick jump cancels the first pending focus; a stale failed jump
  never clears a newer one; the flash timer is cleared on unmount.
- **Why**: Plan; bug fixes for racing jumps.
- **Pinned by**: ui/features/chat/list/MessageList.test.tsx :: loads history around an old message
  and detaches from the present; a second quick "jump to" with focus cancels the first pending focus
  instead of landing on it; says so when the quoted message is not stored locally; ui/features/chat/
  list/MessageListHooks.test.tsx :: lets a stale request clear nothing once a newer target is set;
  releases the flash timer when the list unmounts; ui/features/chat/ChatController.test.ts (3).
- **Search results follow the chat**: the results of the chat search (Mod+F) are searched again
  whenever the chat's loaded messages change in a way that can alter them (a message added or
  removed, deleted, edited; not a receipt, status or reaction), without the loading skeleton: a message deleted for
  everyone, for you or expired leaves the list, a new match joins it, and the result you are on
  stays the same element. Pinned by ui/features/chat/header/SearchPanel.test.tsx :: follows the
  store: a message deleted for everyone leaves the results, a new match joins them; journeys/
  test_keyboard.py :: search_results_drop_a_message_deleted_for_everyone. Not pinned: a message
  outside the loaded window (an old one deleted on the phone) stays listed until the search runs
  again.
- **The Pinned messages list follows the chat the same way** (`header/chatSignature.ts`, shared with
  the search): while the popover is open, a pin removed, a pinned message deleted for everyone or
  expired leaves the list and a new pin joins it, quietly (no loading skeleton). Pinned by
  ui/features/chat/header/PinnedPopover.test.tsx; journeys/test_keyboard.py ::
  pinned_list_drops_a_message_deleted_for_everyone. Not pinned: a message outside the loaded window
  stays listed until the popover is opened again.

### C15. Dates follow the system locale

- **Rule**: Day dividers, timestamps, relative dates and gallery months use the system locale; clock
  times follow the 12/24 h setting. Relative times refresh when the window regains focus.
- **Why**: User request.
- **Pinned by**: core/domain/misc.test.ts :: orders dates by the locale, not always day-first; formats
  12/24h clocks; core/domain/gallery.test.ts :: words month headings in the given locale;
  ui/hooks/useNow.test.tsx :: catches up when the window gets focus.

### C16. Jumbo emoji

- **Rule**: Emoji-only messages render large; a message of just digits, `#` or `*` does not;
  text-presentation symbols are not large unless they carry the emoji selector; keycaps and flags
  are; a custom emoji counts as one unit.
- **Why**: Bug reports.
- **Pinned by**: ui/features/chat/message/MessageBody.test.tsx :: detects emoji-only messages for
  jumbo display; never shows digits, # or * large on their own, but does show keycaps and flags; does
  not show text-presentation symbols large unless they carry the emoji selector; counts a resolvable
  custom emoji as one unit for jumbo display.
  journeys/test_list.py :: jumbo_exceptions_and_inline_custom_emoji (a heart with its selector is
  large; digits and plain text are not; a custom emoji in a sentence sits in the line at the text's
  size), jumbo_emoji_are_shown_large (a plain emoji is large in WebKitGTK too: `JUMBO_GRAPHEME` has no
  lookbehind, which JavaScriptCore does not match on a property escape after a surrogate pair).
- **Not pinned**: a custom emoji alone in a message (jumbo) in real layout.

### C17. Links

- **Rule**: http(s) URLs link safely. Bare domains link (https, text as typed) as in Signal Desktop;
  balanced closing brackets stay in the address, prose brackets don't; emails, IPs, file names and
  non-http schemes do not link; a domain split by a custom emoji, mention or formatting does not link;
  links stop at bidi controls and drop trailing curly quotes, CJK punctuation and ellipsis; a link
  inside a hidden spoiler is unreachable until revealed.
- **Why**: Signal Desktop parity and bug reports.
- **Pinned by**: ui/features/chat/lib/links.test.ts (all); ui/features/chat/message/
  MessageBody.test.tsx :: links bare domains and keeps balanced brackets, leaving prose brackets
  outside; never links a domain split by a custom emoji or by formatting; keeps a link inside a
  hidden spoiler out of reach until the spoiler is revealed.

### C18. Spoilers

- **Rule**: A spoiler is hidden until clicked or revealed from the keyboard.
- **Why**: Signal parity. (Previews, announcements, quotes and notifications never reveal one: S13.)
- **Pinned by**: ui/features/chat/message/MessageBody.test.tsx :: hides spoilers until activated by
  click; reveals spoilers from the keyboard.

### C19. Stickers

- **Rule**: Stickers render as the image alone at 120 px (bubble up to 160 px) with a fixed-size
  placeholder and no hover zoom; they fall back to the history backup image, then an emoji chip;
  previews, notifications and quotes say "Sticker"; clicking opens the pack dialog.
- **Why**: User requests (120 px, drop the hover zoom).
- **Pinned by**: ui/features/chat/message/StickerBubble.test.tsx (all);
  ui/features/conversation/preview.test.ts :: describes a sticker, with its emoji when known;
  core/services/NotificationService.test.ts :: summarises a sticker, with its emoji when known.
- **Not pinned**: the 120 px size and no hover zoom (CSS); a journey measuring the rendered sticker
  would pin them.

### C20. Link preview cards

- **Rule**: Received previews render as cards only when the URL is in the text and http(s). The
  domain label drops "www."; wide images go full width, near-square ones become a thumbnail. In an
  unaccepted request the card is inert (no link, no image fetch).
- **Why**: Signal parity.
- **Pinned by**: ui/features/chat/message/LinkPreviewCard.test.tsx (all six); ui/features/chat/
  message/messageRequestMedia.test.tsx :: shows the card without a link and without fetching its
  image.

### C21. Delivery marks

- **Rule**: Own messages show sent, delivered and read marks; a group row shows the highest status any
  recipient reached; failed sends show no mark; read marks are hidden when the phone has read receipts
  off; Message details lists who read, who was delivered to, who was only sent to and who was not
  delivered to.
- **Why**: Feature request; Signal parity.
- **Pinned by**: ui/features/chat/message/MessageItem.test.tsx :: shows an accessible mark after the
  timestamp, reflecting the message status; shows no status mark for a failed send; is hidden when
  Settings → Privacy → "Show read receipts" is off; ui/features/chat/message/MessageDetails.test.tsx
  (all); core/services/services.test.ts :: a group row shows "read" once any one recipient has; core/
  stores/privacy.test.ts :: hides read marks while the phone has read receipts off.

### C22. Pending messages

- **Rule**: A pending message shows muted text and a "Sending" clock, not 60% opacity.
- **Why**: Accessibility polish (low-opacity text failed contrast).
- **Pinned by**: ui/features/chat/message/MessageItem.pending.test.tsx (the pending mark and the
  "Sending" clock, no fade, both gone once sent); journeys/test_list.py ::
  pending_message_is_muted_with_a_clock (the muted text colour, opacity 1, the clock, then the normal
  colour once sent).

### C23. Disappearing timers

- **Rule**: Incoming timers start when read (at the phone's read time for a read sync, never from the
  future); outgoing ones start at send time, not at acknowledgement; unread messages never expire
  however long they sit; purges recur after startup. The countdown on a row follows the minute clock
  (a read-timer one does not).
- **Why**: Signal parity; a user bug.
- **Pinned by**: core/services/activity.test.ts :: starts it when the phone reads the message; counts
  the timer from the phone’s read time, so a long-due message goes at once; is the conversation’s
  timer when the send goes out, not when it is acknowledged; purges on schedule long after the
  connection finished starting; ui/features/chat/message/MessageMeta.test.tsx :: a disappearing
  countdown follows the clock, a read-timer one does not.

### C24. Unread reactions and votes

- **Rule**: Reactions and poll votes from others on your messages are tracked as unread news, never
  as a message; reading the chat sends a sync-only read for each target.
- **Why**: Signal parity.
- **Pinned by**: core/services/activity.test.ts :: reads a reaction at once while the chat is on
  screen, and syncs it as a read of the target; sends the reaction sync next to the receipts for
  unread messages, never as a receipt; only counts someone else’s reaction to the user’s own message,
  once per emoji; reads a vote at once on screen, and syncs it as a read of the poll; keeps a vote
  unread while away, and never counts it as a message.

### C25. A reader's place holds while rows above change size

- **Rule**: A reader scrolled up stays on the message they are reading when rows above the view
  change size: a reaction added or removed, an edit that makes a message taller or shorter, a delete,
  the history skeleton giving way to the start of the chat. The list keeps the first message in view
  at the same distance from the top of the list (`list/readingAnchor.ts`). It does nothing while the
  reader is scrolling (the virtualiser looks after the rows it measures then; a scroll event within
  100 ms; the scroll event of the list's own correction is not the reader's, so two changes less than
  100 ms apart are both corrected), while older history is being prepended (the virtualiser keeps the view, C6), for a list
  pinned to the bottom (C1, C5: its end stays in view) or held where it opened at the unread divider
  or a jump target (C5: until the reader moves it).
- **Why**: Bug found by exploring live events: the virtualiser compensates for a row changing size
  above the view only while the reader is scrolling up (its upward compensation ends 50 ms after the
  last scroll event), so a reaction on an older message pushed the message being read down by the
  height of the new row.
- **Pinned by**: ui/features/chat/list/readingAnchor.test.ts (including: does not take its own
  correction for the reader scrolling); journeys/test_list.py ::
  reaction_on_a_message_above_the_view_does_not_move_the_reader (reactions, two back to back, a tall
  edit and a delete on messages above a reader who scrolled up).
- **Density switch**: Toggle compact mode changes every row's height; measured, the first message in view stays within a pixel (journeys/test_appearance.py :: density_switch_keeps_a_scrolled_up_readers_message_in_place), so the anchor already covers it. A reader within the follow slack of the end is pinned to it (C1), not anchored.
- **Not pinned**: a list held at the divider or a jump target is left to C5, so a row above it
  changing size there still moves the view; a composer growing under a scrolled-up reader.

---

## M. Message actions and keyboard

### M1. One permission table

- **Rule**: One pure rule set (`messagePermissions` / `MESSAGE_ACTIONS`) gates every action for the key
  handler, command handler, context menu, hover bar and ArrowUp. Reply needs a chat you can write in;
  Edit is hidden on failed or pending messages; failed sends offer only Retry and Discard.
  The actions that send something to the other side (React, Edit, Pin and Unpin, Delete for
  everyone, an admin's delete) follow whether the chat can send (`canCompose`: accepted, not blocked,
  not a group you left, not an announcement group you cannot write in), the same in all three
  states, on the bar, the menu, the keys and Vim; Copy, Delete for me, Message details, Forward and
  Reply where the chat allows it stay.
- **Why**: Bug report: the surfaces disagreed about what was allowed.
- **Pinned by**: core/domain/messageActions.test.ts (all nine); ui/features/chat/message/
  actions.test.tsx :: drives the menu from the table entry, not from its own gate; ui/features/chat/
  message/MessageItem.rules.test.tsx :: offers reply from the key, the menu and the bar where there is
  a composer; does not edit a failed message from the key either (the menu never offered it);
  core/domain/messageActions.test.ts :: offers no sending action where the chat cannot send;
  ui/features/chat/message/MessageItem.refusals.test.tsx :: offers no reaction, edit, pin or delete
  for everyone where you cannot send; journeys/test_dialogs.py ::
  a_group_you_left_offers_no_sending_actions_on_a_message.

### M2. Edit limits

- **Rule**: Own messages with text can be edited within 24 hours, up to 10 edits; note-to-self is
  exempt; stickers, polls and voice messages are not editable. The editor keeps its text and says why
  when refused; the Edit button disappears when the window closes while the row is on screen.
  E on a message that cannot be edited says why (a toast: "Messages can only be edited for 24
  hours.", "This message can't be edited.", "You can't edit messages in this chat.") and types
  nothing into the composer. The inline editor compares what is saved with the message as it is now,
  not as the editor opened it: after another device edits the message, text that differs from its
  current body is sent, text equal to it closes without sending. Incoming edits to messages older
  than 48 hours are dropped.
- **Why**: Signal parity.
- **Pinned by**: core/domain/editing.test.ts (all); ui/features/chat/message/MessageItem.rules.test.tsx
  :: stops offering Edit in the bar once the window closes while the row is on screen; says why when
  Edit is pressed on a stale row, and does not open the editor; core/services/services.test.ts ::
  refuses an edit once the 24 hour window has closed; drops an edit that reaches the server more than
  48 hours after its message; ui/features/chat/message/MessageItem.refusals.test.tsx :: says why E does
  nothing on your own message past the window, and types nothing; ui/features/chat/message/
  MessageEditor.test.tsx :: compares with the message as it is now; closes without sending when the text
  equals the message as it is now; journeys/test_keyboard.py ::
  e_on_an_own_message_past_the_edit_window_says_why,
  an_edit_saved_after_another_device_edited_the_message_is_sent.

### M3. Delete

- **Rule**: Delete for everyone is offered only within 24 hours (never in note-to-self). Delete or
  Backspace on your own message deletes for everyone, on someone else's deletes for you; it asks
  first with the destructive button focused. Shift skips the question on the key (Shift+Delete, read
  from that key press, so it works on a clicked row too) and on the hover bar, which shows the quick
  delete while Shift is held and keeps it across messages after a delete. The message menu's Delete
  always asks. A message you
  delete for yourself that nobody has read also leaves the chat's unread count.
- **Why**: Signal parity; bug report: Shift reset after each delete.
- **Pinned by**: ui/features/chat/message/MessageItem.test.tsx :: Delete asks first, with the
  destructive button focused so Enter confirms; ui/features/chat/message/MessageItem.rules.test.tsx ::
  offers delete for everyone only for 24 hours, where recipients still accept it; ui/features/chat/
  message/useShiftHeld.test.tsx (both); MessageItem.test.tsx :: Shift+Delete on a focused row deletes
  without asking, though no hover bar is listening for Shift; journeys/test_delete.py ::
  shift_delete_across_messages (three messages deleted in a row with Shift held, no dialog),
  shift_delete_on_a_message_focused_by_click; core/services/deleteSync.test.ts :: takes a
  deleted unread message off the unread count, so reading the chat leaves none behind.
- **A deleted message stays deleted**: a message deleted for everyone takes no reaction and no pin
  that arrives afterwards (edits and poll votes were already refused). Pinned by core/services/
  services.test.ts :: ignores a reaction or a pin that arrives after the message was deleted for
  everyone; journeys/test_list.py :: late_reaction_does_not_show_on_a_deleted_message.
- **A quote of a deleted message**: a reply whose quoted message was deleted for everyone stops
  showing the quoted text, also when the reply arrived (and stored the text) before the deletion: the
  quote shows what the deleted row shows ("This message was deleted."), with the author kept. It is
  resolved when the row renders, from the messages loaded in the chat; a quoted message outside the
  loaded window keeps showing its stored text until it is loaded. Pinned by ui/features/chat/message/
  MessageItem.refusals.test.tsx :: a quote of a message deleted for everyone; journeys/
  test_keyboard.py :: a_quote_of_a_message_deleted_for_everyone_stops_showing_its_text.

### M4. Failed and unconfirmed sends

- **Rule**: A failed send says "Failed to send" with Retry and Discard. A send that timed out or
  whose answer couldn't be read is "May have sent" with "Send again" and a warning on every retry
  surface. A send cut off by quit comes back as "May have sent" with its outbox entry kept. Retry is
  single-flight.
- **A change made to a message that is still sending**: if its send then fails, nothing went out.
  A delete discards the message (no row, no outbox entry, no failure dialog, no safety-number
  prompt); an edit rewrites what a retry will send, and the failed row shows the new text; a reaction
  is dropped, as there is nothing to react to. Pinned by core/services/services.test.ts :: changes
  queued on a message whose send then fails (all three); journeys/test_delete.py ::
  deleting_a_message_that_is_sending_discards_it_when_the_send_fails.
- **Why**: Data safety: never double-send silently.
- **Pinned by**: ui/features/chat/message/MessageNotes.test.tsx (all); core/services/services.test.ts
  :: a send that timed out is marked unconfirmed, and a retry clears that; marks a send aborted by
  shutdown as unconfirmed, not as a plain failure; core/services/races.test.ts :: two overlapping
  retry() calls send exactly once; app/DesktopBootedApp.quit.test.tsx :: records "may have sent"
  before the exit flush writes the repository.

### M5. Forward

- **Rule**: Forward is in the menu and on Ctrl/Cmd+Shift+S for the focused message. Up to five chats;
  an edit step only for a single text message; it carries text, styles, attachments, stickers and link
  previews and drops quotes, reactions and edit history. Polls, deleted, system and empty messages and
  unsent or failed own messages are not forwardable; stickers and voice messages are not editable
  when forwarded. Forwarding to a request accepts it (with a warning); retry sends only what didn't
  go; oversize or empty files are refused before sending. A chat that becomes unavailable after it was
  picked (a group left, blocked, announcement-only) is shown as unavailable in the footer while the
  dialog is open and is checked again at send (`forwardToTarget`): it is skipped, never sent to, and
  named in the result toast ("Forwarded to Ines. Not sent to Crux (You left this group)."); when
  nothing else went, the dialog stays open with the reason. A message being forwarded that is deleted
  for everyone or expires meanwhile closes the dialog with a "This message was deleted" toast (M15);
  nothing deleted is ever forwarded.
- **Why**: Signal Desktop parity.
- **Pinned by**: core/domain/forward.test.ts; ui/features/forward/model.test.ts, media.test.ts and
  send.test.ts (including forwardToTarget re-checks the chat at send); ui/features/forward/
  ForwardDialog.test.tsx (all, including its message goes and a picked chat that becomes
  unavailable); ui/features/chat/message/MessageItem.forward.test.tsx (all); journeys/test_dialogs.py ::
  forward_closes_when_its_message_is_deleted_for_everyone,
  forward_does_not_send_to_a_group_left_after_it_was_picked.

### M6. Message request actions

- **Rule**: Until a request is accepted you cannot reply, react, pin, vote or forward; the author can
  still end their own poll.
- **Why**: Signal parity.
- **Pinned by**: ui/features/chat/message/messageRequestActions.test.ts (all four); ui/features/chat/
  message/actions.test.tsx :: offers no reply, react or forward in a message request.

### M7. Pins

- **Rule**: Pin and Unpin are in the message menu. The timeline says "You pinned a message" or "{name}
  pinned a message" with a "Go to message" button; unpinning writes nothing.
- **Why**: Signal Desktop parity.
- **Pinned by**: core/services/timelineLines.test.ts (pin cases); ui/features/chat/list/
  SystemRow.test.tsx :: has a keyboard-reachable Go to message button that reveals the pinned message.

### M8. Default shortcuts

- **Rule**: The defaults are those in [KEYBOARD.md](KEYBOARD.md), all rebindable. Mod+F searches the
  chat and Mod+Shift+F searches all chats, the reverse of Signal Desktop, so existing bindings don't
  move. Tab or Esc cancels a keybind recording; Backspace or Delete removes the binding. The
  recorder refuses an unmodified Enter, Space or printable key (Shift alone does not count) for any
  command, with a short message under the row: such a shortcut would stop buttons activating and the
  typed character starting a message. A command's own default is exempt (none of the shipped ones is
  a plain key but Esc, which cannot be recorded), and Vim mode's keys are a key layer, not bindings.
- **Why**: User request; the Mod+F deviation was decided explicitly.
- **Pinned by**: core/commands/commands.test.ts :: parses every default keybind; ui/features/search/
  GlobalSearch.test.tsx :: opens from Mod+Shift+F with focus in the field, and leaves Mod+F for the
  chat; ui/features/newChat/NewMessageDialog.test.tsx :: opens from Ctrl+N; ui/features/settings/
  keybinds/record.test.ts (all, including that a global shortcut refuses unmodified Enter, Space and
  printable keys); journeys/test_dialogs.py :: the_shortcut_recorder_refuses_a_plain_enter_key;
  ui/features/settings/keybinds/KeybindRecorder.test.tsx :: lets Tab
  move focus on, ending the recording without a binding.
- **Not pinned**: that each default key is the one KEYBOARD.md lists (the test only checks they
  parse); a test comparing the defaults to a table would pin it.

### M9. Message-list keys

- **Rule**: Up and Down move between messages. Enter steps into a message (Tab reaches its controls,
  hover bar first), Esc steps out; R replies, E edits, + (or =) reacts; Shift+F10, the Menu key and
  Mod+Enter open the menu; Esc in a reaction picker opened with + returns to the message (one opened
  from the hover bar's button returns to that button). When the message you stepped into (or whose
  reaction picker you opened) is deleted for everyone meanwhile, its buttons go and focus goes back to
  the row, as Esc would, but only when focus was in the row or its picker until then (not after the
  reader clicked or tabbed elsewhere). A message open in the inline editor that is deleted for everyone closes the editor, with a
  "This message was deleted" toast (P4). When the focused message scrolls out of the
  rendered range (PageUp, the wheel), the list's scroller takes focus, unless focus went somewhere
  else, and the arrows continue from that message. A message row is an article labelled by author
  and time. The row's own keys (R, E, +, =, Delete, Backspace) are always the row's: when the action
  is refused (a reply in a chat you cannot write in, a delete of a failed message, an edit past the
  window, which says why) the key is still consumed and never falls through to the composer as typed
  text. Picking the emoji you already reacted with (the picker, a quick reaction, the menu) removes
  your reaction, as in Signal Desktop and Discord.
- **Why**: User request (keyboard-first).
- **Pinned by**: ui/features/chat/message/MessageItem.test.tsx :: is an article labelled by author and
  time, described by its body; keeps inner controls out of the tab order until the row is entered; R
  replies, E edits; + opens the reaction picker; journeys/test_keyboard.py :: reply_then_edit (arrows
  between messages, R from the keyboard), enter_steps_into_a_message_and_escape_out (Enter moves
  focus into the hover bar, Tab goes on, Esc puts it back on the row), message_menu_keys_open_the_menu
  (Shift+F10, the Menu key and Ctrl+Enter each open the menu; Esc returns focus to the row),
  reaction_picker_esc_returns_to_the_message, page_up_keeps_focus_on_the_list;
  ui/features/chat/message/MessageItem.test.tsx :: Esc closes a picker opened with + onto the message;
  one opened from the bar button returns to that button; keeps focus on the row when the message is
  deleted for everyone while it is stepped into, and leaves it alone after a click elsewhere (both); journeys/test_keyboard.py ::
  remote_delete_of_the_message_you_stepped_into_keeps_focus; journeys/test_delete.py ::
  edit_closes_when_its_message_is_deleted_on_another_device;
  ui/features/chat/message/MessageItem.refusals.test.tsx :: keeps R, Delete and + from falling through
  to the composer when they are refused, and picking the emoji you reacted with (removes your
  reaction); journeys/test_keyboard.py :: picking_the_emoji_you_reacted_with_removes_it.
- **Not pinned**: Shift+F10 and the Menu key through the app's own code: WebKitGTK turns both into a
  `contextmenu` event itself, so the journey stays green with those two branches of
  `isContextMenuKey` removed (Ctrl+Enter is the app's alone and is pinned). Mod+Enter with the Meta
  key.

### M10. Vim mode is opt-in

- **Rule**: Vim mode is off by default and the app keeps its default keys; disabling it restores
  default behaviour completely; an intro toast shows once.
- **Why**: User request.
- **Pinned by**: ui/plugins/vim/vim.integration.test.tsx :: is off by default and the app keeps its
  default keys; restores default behaviour completely when disabled; shows a one-time intro toast.

### M11. Vim: opening a conversation never lands in the composer

- **Rule**: Every open path (sidebar click, J/K, ]u, gt, switcher, notification) lands on the message
  list. "Focus the message box" is ignored and type-to-focus is off; only i, a, I, A and gi focus the
  composer. J/K from a focused sidebar row follows to the new row. Outside Vim mode this is
  unchanged. With the navigation keys off and modal editing on, type-to-focus stays on (letters are
  not commands then): a letter typed away from a text field goes into the composer, which, if it
  would open in Normal mode, switches to Insert mode with the caret at the end of the draft first, so
  the letter is added after the draft and never replaces the character under the block cursor. A
  composer already in Insert mode takes the letter as it is. Saving or cancelling a message edit puts focus on the message list, not the composer (P4). So does `dd` (the message list, the message before the deleted one) and the search panel's close button (`ChatController.focusAfterPanel`); without Vim they keep going to the composer, and the fallback of M15 stands in the list for the composer likewise.
- **Why**: User request and bug report.
- **Pinned by**: ui/plugins/vim/vim.integration.test.tsx :: a sidebar click with the composer focused
  lands on the message list, not the composer; J/K from the list lands on the list; J/K from a sidebar
  row stays on the sidebar; i focuses the composer from a sidebar row; gi focuses the composer with
  the caret at the end of the draft, from anywhere; outside Vim mode, a sidebar click leaves focus on
  the clicked row; outside Vim mode, type-to-focus still sends a stray letter to the composer;
  with only the composer half on, a letter typed from the list opens a Normal-mode composer in Insert
  mode at the end of the draft;
  ui/hooks/focusTargets.test.ts (all); journeys/test_vim.py :: vim_every_open_path_lands_on_the_list
  (a click from the composer, J, K, ]u, gt and gT, the switcher and a clicked notification, with
  "Focus the message box" on); journeys/test_vim.py ::
  vim_modal_editing_alone_keeps_the_draft_when_typing_from_the_list; journeys/test_vim.py ::
  vim_dd_lands_on_the_list_after_deleting_the_newest_message, vim_search_close_button_lands_on_the_list; journeys/test_vim.py ::
  vim_edit_ends_on_the_message_list; ui/features/chat/message/MessageEditor.test.tsx :: is the message list, not
  the composer, with Vim navigation on (M11).
- **Not pinned**: nothing.

### M12. Vim: Esc returns to the message list

- **Rule**: From any sidebar row, rail tile, header button or empty text field, Esc focuses the
  message list so j/k and J/K work. A non-empty field clears first (not the chat search panel's field:
  the panel owns Esc and closes, see M15); with no conversation open it
  blurs. In the composer's Normal mode Esc cancels a reply, then (empty draft) marks read and returns
  to the list; the first Esc in Insert mode never marks anything read. Where the app gives Esc a
  meaning of its own, that comes first: in the inline message editor (also when its text was cleared)
  Esc cancels the edit, and while a voice message is being recorded Esc cancels it, wherever focus is.
- **Why**: Bug report; Vim's Esc was consumed ahead of the editor's cancel and the recorder's.
- **Pinned by**: ui/plugins/vim/VimController.test.ts :: runs FocusMessages on Esc from an empty input
  field; leaves Esc to a non-empty input field; blurs to the document body when no conversation is
  open; ui/plugins/vim/vim.integration.test.tsx :: keeps Escape-marks-read for Normal mode on an empty
  draft, and returns to the messages; ui/plugins/vim/VimController.test.ts :: leaves Esc to what the
  app marked as owning it; ui/hooks/textSurfaces.test.ts :: describeFocus escapeOwned (all);
  journeys/test_vim.py :: vim_escape_returns_to_the_list (the search panel part: Esc closes it),
  vim_escape_in_an_emptied_message_editor_cancels_the_edit, vim_escape_cancels_a_voice_recording.
- **Not pinned**: nothing.

### M13. Vim: composer

- **Rule**: The composer starts in Insert mode (setting); suggestions show only in Insert; IME input in
  Normal mode switches to Insert as one undo step; the Normal and Visual caret is an always-visible
  block (hollow when unfocused); a mode pill and accessible description show the mode; the mode
  survives a voice recording; the mode shows on the TUI status line. In Normal mode Enter sends and
  Shift+Enter makes a new line before the character under the cursor (one undo step, still Normal
  mode), whatever the send-key setting says: the swap in Settings is for the Insert-mode field.
- **Why**: User request.
- **Pinned by**: ui/plugins/vim/vim.integration.test.tsx :: starts in Insert mode; turns IME input in
  Normal mode into one Insert change; enters Insert mode on the IME keydown (keyCode 229) before
  compositionstart; shows a block in an empty composer; turns hollow while the composer is
  unfocused; shows its NORMAL/INSERT mode on the TUI shell status line; ui/plugins/vim/caret/
  caretCell.test.ts (all); ui/features/chat/composer/Composer.voice.test.tsx :: keeps key layers (Vim
  mode) attached to the text field across a recording; journeys/test_vim.py ::
  vim_composer_modes_and_caret (the block's painted pixel), vim_mode_shows_on_the_tui_status_line,
  vim_normal_mode_enter_sends_and_shift_enter_makes_a_new_line,
  vim_normal_mode_enter_sends_whatever_the_send_key_setting; ui/plugins/vim/engine/engine.test.ts :: makes a new
  line on Shift+Enter in Normal mode, sending nothing and staying put; ui/plugins/vim/vim.integration.test.tsx ::
  sends on Enter and makes a new line on Shift+Enter in Normal mode, whatever the send key.
- **Not pinned**: IME input in WebKitGTK (the runner cannot compose).

### M14. Vim counts and sequences

- **Rule**: `5j`, `3J` and `d2w` work; a sequence waits for the sequence timeout (1000 ms default);
  Esc clears it; counts on app keys run one after another; Space and Enter are never swallowed on
  buttons; letters are inert in plain text inputs.
- **Why**: User request.
- **Pinned by**: ui/plugins/vim/VimController.test.ts (all); core/commands/keyLayer.test.ts (all);
  ui/plugins/vim/vim.integration.test.tsx :: clears a pending sequence with Esc and drops it after the
  timeout; never blocks Space or Enter on a focused button.

### M15. Dialogs return focus to their opener

- **Rule**: One mechanism gives focus back when a Modal, full-screen dialog, drawer or lightbox
  closes. A dialog replaced by another keeps the chain's opener; the fallback is what had focus before
  a palette or menu, then the menu trigger, then the composer; the chain is followed whenever the
  opener is gone and focus is on the page body, nothing or inside the closing dialog (focus the user
  put elsewhere stays; the menu's trigger is forgotten when the menu closes), whatever opened the dialog (`fallbackFocus` in `primitives/openerFocus.tsx`: a
  request bar that the phone answered under its question, a member removed under their profile
  card). A dialog whose subject disappears closes: the delete-for-everyone question and Message
  details of a message deleted for everyone meanwhile (the inline editor is a separate decision). Dialogs with a hidden header have no invisible Close; a drawer takes one Esc from any
  descendant. A panel closed by its shortcut with focus inside hands focus on as its own close does:
  the search panel (a second Mod+F) to the composer, the wide member column (Mod+Shift+M) to its
  header toggle.
- **A focused thing that leaves hands focus on**: a row with focus that disappears (a chat archived
  or deleted on the phone, a member removed, a message deleted for me on the phone or expired) gives
  focus to the next row of the same list, else the previous, else the list's own tab stop, else the
  fallback (`useHandOffRow` / `useHandOffWhenGone`; the message list does the same by data,
  `neighbourOf`); the fallback is what had focus before, the menu trigger, the composer (the message
  list while Vim's navigation keys are on, M11), the message list, the conversation list's tab stop,
  never the page. The same for a pane that leaves: the open chat deleted on the phone is unselected
  (the pane shows what it shows with nothing open), the sidebar leaving for the closed drawer below
  760 px (S20), and Settings' nav narrowed below 760 px (focus goes to the page's heading). Only focus
  that was on the thing that left moves; focus the user put elsewhere is never taken. The same
  mechanism covers a row whose menu had focus (a menu opened from a row by Shift+F10 or a right
  click: Archive, Move to space, Remove from space, Move to category): focus in the menu counts as
  focus on the row it was opened from, and the hand-off acts once the menu has closed; a thing that
  stays but is mounted anew (a row filed under another category, a rail tile that goes into or out
  of a folder, a folder tile that collapses or expands) gets focus back on its new element. A
  category deleted from its header menu hands focus to the next category's header, else the
  previous, else the list's tab stop. While the navigation drawer is open, the fallback stays inside
  it (its rail or list), never on the header button behind it: a space deleted in the drawer leaves
  focus there.
- **What had focus at the bottom of the chat is replaced** (`ConversationArea`): a request bar's
  button taken away (the request answered on the phone under a focused Accept or Block, Accept
  taken away by the composer, Block by the blocked bar) hands focus to the composer if one now
  shows, else the message list; the composer replaced by a notice or a bar (the group made
  admins-only, left, the chat blocked on the phone) hands focus to the message list, not to the
  bar's own buttons (nothing takes focus by itself there, so a stray Enter can't answer it).
  Confirming Delete on a request from its bar goes to the row next to the chat's own in the
  conversation list, as a phone-side delete does (`ChatColumn`: the next row, else the previous,
  else the fallback).
- **Behind an open modal dialog the fallback stays inside it** (Settings, a confirmation): the
  fallback chain (`fallbackFocus`) only offers places inside the topmost open layer (`topLayer`: the
  topmost modal dialog, else the topmost open drawer: the member drawer over the navigation drawer
  at narrow width, never the drawer behind it), and a closing dialog does not move focus that already
  sits inside another open dialog. Unblocking in Settings >
  Privacy hands focus to the next entry's Unblock, else the previous, else the empty state, never a
  row of the list behind Settings.
- **A working button keeps focus**: `Button` takes `busy` (`aria-disabled` and `aria-busy`, ignoring
  activation) instead of `disabled` for a button that is working, since WebKit drops focus to the
  page when the focused button becomes `disabled`; the dialogs' buttons (`ConfirmDialog`, Safety
  Number, Safety Number Changes, sign-out, the request bar) keep focus while busy and after a failure.
  The same for a button or switch that goes inert by its own action (Keybinds' Reset all, Save and
  Discard on My profile, a plugin's Reset to defaults, a setting switch while its change is pending):
  `Button` and `Switch` stay focusable, `aria-disabled` and ignoring activation, while they are
  disabled and have focus, and become `disabled` once focus leaves (`useSoftDisabled`). A disabled
  one without focus is `disabled` as ever.
- **A group dialog whose action became impossible closes** with a short toast ("You can no longer
  change this group.", "You are no longer in this group." for Leave group), focus handed on as for
  any closing dialog: Edit group, Add members, Permissions, Group link and a member action after
  you were demoted or left on another device (`useCloseWhenImpossible`). A dialog opened read-only
  (a plain member's Group link) stays, and leaving from the Leave dialog itself closes it without
  the notice.
- **The connection banner's Retry**: activating it takes the button away (the banner turns to
  "Reconnecting"); focus goes to what had it before, else the composer, never the page. Pinned by
  ui/features/chat/ConnectionBanner.test.tsx :: hands focus on, never to the page, when Retry is
  taken away.
- **The toast list** (Alt+T moves focus into it): Esc returns focus to where it was before Alt+T;
  when the focused toast expires or is dismissed, focus goes to the next toast, else back to where it
  was before (the fallback when that is gone), never the page (`primitives/toastFocus.ts`). Focus
  that leaves the list any other way (a shortcut that opens a dialog, a click, Shift+Tab) stays where
  it went: sonner would give the element from before Alt+T focus back whatever took it, so it is never
  told where that was. Pinned by
  ui/features/shell/ToastFocus.test.tsx (all); journeys/test_keyboard.py ::
  esc_in_the_toast_list_returns_focus_to_where_it_was,
  esc_in_the_toast_list_never_leaves_focus_on_the_page,
  a_focused_toast_that_goes_hands_focus_to_the_next_toast_else_back,
  a_dialog_opened_from_the_toast_list_takes_focus. The fallback skips toasts: it is never a toast the
  user has left.
- **Next / Previous space by a bound key** (`stepSpace`, `followSpaceFocus`): focus that was in the
  sidebar (a row, New message, a heading) goes to the new space's list tab stop, focus on the rail to
  the new space's tile, and focus that would fall to the page lands on the list's tab stop; focus
  elsewhere stays. Outside Vim too; with Vim's navigation keys on, its own landing wins (M11).
  Pinned by ui/hooks/focusTargets.test.ts :: describe "followSpaceFocus"; journeys/test_keyboard.py ::
  next_space_key_from_a_sidebar_row_keeps_focus_off_the_page.
- **A control that goes inside Settings hands focus to the nearest one that stays**
  (`settings/keepFocusOnPage.ts`, on the pages' region): a "Reset to default" that has nothing left to
  reset, Reassign or Cancel in the conflict prompt, "Remove emoji", a plugin card filtered away.
  Within the closest ancestor that still holds a control: one marked as the row's anchor (the
  shortcut button), else one of the same kind (a button for a button, a switch for a switch), else the
  closest in DOM order, the one before on a tie; none left near it, focus stays where it fell
  (the dialog). Focus the user put elsewhere is never taken. Pinned by
  ui/features/settings/keepFocusOnPage.test.tsx (all); journeys/test_dialogs.py ::
  a_keybind_reset_or_conflict_prompt_hands_focus_to_the_recorder.
- **A member menu's Profile item moves focus into the card**, as a click or Enter on the row does:
  the row is clicked once the menu has closed and handed focus back (`afterMenusClosed`), so the
  menu's focus return no longer lands after the card's. Pinned by journeys/test_dialogs.py ::
  a_member_menus_profile_item_moves_focus_into_the_card.
- **The search panel owns Esc**: Esc anywhere in it closes it, a field with text and a result
  included, and so does Esc on the message that Enter (or a click on a result) moved focus to, until
  focus goes elsewhere; focus then goes to the composer (the list in Vim mode).
- **Shortcuts behind a menu**: a global shortcut pressed with a menu open (a dropdown, a context
  menu, a submenu) closes the menu first, the way Esc does, then runs once the menu has handed focus
  back to its trigger, so the command's own focus is the last word (`primitives/menuClose.ts`,
  `shell/useKeyboard.ts`; the dispatcher's `defer`). A dialog it opens therefore never sits over a
  menu, and Esc on it returns focus to the menu's trigger. Pinned by ui/primitives/menuClose.test.tsx
  (all); core/commands/commands.test.ts :: hands a matched command to the context's defer;
  journeys/test_dialogs.py :: dialog_opened_over_a_dropdown_menu_leaves_no_menu_open_behind_focus,
  a_shortcut_pressed_with_a_dropdown_menu_open_closes_it_and_acts.
- **Shortcuts behind a dialog**: while a Modal, full-screen dialog or lightbox is open, none of the
  global shortcuts run (`primitives/modalOpen.ts`, `shell/useKeyboard.ts`): every one acts on the app
  behind the dialog (switching chats, toggling panels) or opens another dialog over it, and none is
  needed inside one. The dialog's own keys and Esc still work; drawers and popovers don't count.
  Vim's layer decides by its own focus context.
- **A reaction pill that leaves hands focus on**: removing your reaction (or another's going) while its
  pill has focus gives focus to the next pill, else the previous, else the message row
  (`Reactions`, `useHandOffRow`). Pinned by ui/features/chat/message/Reactions.test.tsx (both);
  journeys/test_keyboard.py :: removing_your_only_reaction_with_its_pill_keeps_focus_off_the_page.
- **The hover bar holds focus**: the bar stays while focus is inside it (a clicked button, its More
  menu), whatever the pointer does; when it does go (the message changes under it) focus goes to the
  row, unless the user put it elsewhere. Pinned by ui/features/chat/message/
  MessageItem.refusals.test.tsx :: the hover bar while focus is inside it; journeys/test_keyboard.py ::
  hover_bar_button_clicked_then_pointer_leaves_keeps_focus_off_the_page.
- **Why**: Bug reports: focus was lost to the page body.
- **Pinned by**: ui/features/shell/ModalHost.focus.test.tsx (all); ui/primitives/Modal.test.tsx (all
  seven, and describe "the layer that owns focus"); ui/primitives/Button.test.tsx (disabled while it
  has focus, a Switch that goes inert); journeys/test_dialogs.py ::
  reset_all_keybinds_keeps_focus_off_the_page, saving_the_profile_keeps_focus_off_the_page,
  resetting_plugin_settings_keeps_focus_off_the_page,
  dialog_closing_over_two_drawers_keeps_focus_in_the_top_one; ui/features/shell/ModalHost.suspense.test.tsx; journeys/test_dialogs.py ::
  dialog_returns_focus_to_its_button (New message and Settings, closed with Esc),
  replaced_dialog_returns_focus_to_the_first_opener (New message, then New group, then Esc: back on
  the New message button), palette_command_dialog_returns_focus_to_what_had_it (a message, Ctrl+K,
  Open settings, Esc: back on that message), alt_arrow_in_settings_leaves_the_open_chat;
  test/shell.test.tsx :: panels closed by their shortcut keep focus (both); Alt+Up/Down,
  Ctrl+Shift+M, Ctrl+K and Ctrl+F do nothing behind Settings; they work again once it closes;
  journeys/test_keyboard.py :: second_search_shortcut_keeps_focus, member_panel_shortcut_keeps_focus,
  removed_member_with_focus_hands_it_to_the_next_member_else_the_previous,
  message_removed_on_the_phone_hands_focus_to_the_next_message_else_the_previous,
  search_esc_closes_the_panel_with_text_in_the_field_and_on_a_result,
  search_esc_closes_the_panel_after_enter_moved_focus_to_the_match; journeys/test_sidebar.py ::
  archived_focused_row_hands_focus_to_the_next_row_else_the_previous,
  deleted_on_the_phone_open_chat_is_unselected, folder_collapse_by_keyboard_keeps_focus_off_the_page,
  folder_menu_actions_keep_focus_on_the_tiles, deleting_a_category_keeps_focus_off_the_page,
  row_menu_move_to_space_keeps_focus_off_the_page, row_menu_archive_keeps_focus_off_the_page,
  row_menu_remove_from_space_keeps_focus_off_the_page,
  row_menu_move_to_category_keeps_focus_on_the_chat,
  deleting_a_space_in_the_drawer_keeps_focus_in_the_drawer; ui/hooks/useHandOffWhenGone.test.tsx ::
  a row whose menu had focus (both), a thing that stays but is mounted anew (both);
  journeys/test_dialogs.py ::
  settings_nav_item_with_focus_hides_when_the_window_narrows; ui/hooks/useHandOffWhenGone.test.tsx;
  ui/primitives/Modal.test.tsx :: modalDialogOpen; when its opener went with it, falls back to what
  had focus before, then to the composer; a popover whose trigger is removed under it hands focus to
  the fallback; when its opener went with it, leaves focus where the user put it; ui/primitives/
  menuReturn.test.tsx :: forgets what a menu was opened from once the menu closes; ui/features/chat/message/MessageItem.test.tsx :: closes the delete confirmation when
  the message is deleted for everyone meanwhile; closes Message details when the message is deleted
  for everyone meanwhile; journeys/test_dialogs.py :: request_answered_on_the_phone_under_an_open_dialog,
  dialogs_of_a_message_close_when_it_is_deleted_for_everyone,
  request_accepted_on_the_phone_under_its_focused_accept_button,
  request_blocked_on_the_phone_under_its_focused_block_button,
  deleting_a_request_from_its_bar_keeps_focus_off_the_page,
  group_made_admin_only_under_a_focused_composer,
  group_left_on_another_device_under_a_focused_composer,
  chat_blocked_on_the_phone_under_a_focused_composer,
  marking_verified_keeps_focus_in_the_safety_number_dialog,
  unblocking_in_settings_keeps_focus_inside_settings,
  edit_group_closes_when_you_lose_the_right_to_change_it,
  leave_group_closes_when_you_already_left_on_the_phone; ui/features/chat/request/
  MessageRequestBar.test.tsx :: what had focus at the bottom of the chat is replaced (all five);
  ui/primitives/Button.test.tsx (all three); ui/primitives/Modal.test.tsx :: fallbackFocus behind an
  open modal dialog; ui/features/settings/pages/BlockedList.test.tsx :: unblocking inside an open
  dialog; ui/features/groups/groups.test.tsx :: a group dialog whose action became impossible. The fallbacks overlap (the recorded opener, then the
  focus history), so the replaced-dialog journey fails only when the whole restore breaks, not when
  one layer does.
- **Menu items**: a dialog opened from a menu item (Delete for me, Message details) does not
  remember the item as its opener, which is gone when the dialog closes: it uses what the menu was
  opened from (`primitives/menuReturn.ts`; a dropdown's trigger, or what had focus when a context
  menu opened), so focus returns to the message or button. Pinned by primitives/menuReturn.test.tsx
  and journeys/test_dialogs.py :: message_menu_dialog_returns_focus_to_the_message.
- **Not pinned**: drawers in real WebKitGTK.

### M16. Menus and lists

- **Rule**: Menu entries keep submenus, checks and disabled state in the profile card and the action
  sheet. Shift+F10, the Menu key and Mod+Enter open the focused item's menu. Every list is one tab
  stop; in the sidebar it is a row, or, when no row shows (every category collapsed with nothing
  pinned, unread or open), the first section header, so the category can be expanded by keyboard. Long pickers (over 80 rows) are windowed and Enter always picks the highlighted row, even
  after it scrolls out; member lists keep one tab stop on a mounted row.
- **Why**: Bug report (long lists) and plan.
- **Pinned by**: ui/features/newChat/longLists.test.tsx (all); ui/features/groups/
  ContactChecklist.test.tsx; ui/features/members/MemberList.test.tsx (all); ui/features/members/
  MenuEntryButtons.test.tsx; ui/features/chat/message/MessageActionSheet.test.tsx;
  ui/features/sidebar/ConversationList.collapsed.test.tsx :: has its first heading as the one tab
  stop while no row shows; journeys/test_sidebar.py ::
  collapsed_category_with_nothing_showing_can_be_reached_by_tab.
- **A message menu follows its data while open**: entries that depend on the chat's state (Pin,
  Reply, React and Forward need it accepted, which comes from contacts and accepted chats that load
  after the first paint) appear in a menu that is already open once that data arrives. Pinned by
  ui/features/chat/message/MessageItem.refusals.test.tsx :: an open menu follows the data it was
  built from.

### M17. "Message" in a profile card focuses the opened chat

- **Rule**: Choosing "Message" in a profile card focuses the opened chat, not the member row.
- **Why**: Bug report.
- **Pinned by**: ui/features/members/ProfileTrigger.test.tsx (all three).

### M18. Delete for me syncs with your other devices

- **Rule**: A message you delete for yourself here is also removed on the phone and your other linked
  devices (local first; a failed sync never brings it back and reports no error; unsent messages and
  system lines are not synced). Deletes made on the phone are applied here: a single message by
  author and sent time (or the latest edit's time, as Signal matches revisions), and a chat delete up
  to the newest message the phone still had, with a full delete clearing what is left only when no
  real message remains. Unsent messages are kept. Deleted messages are remembered so a replay after a
  reconnect cannot bring them back, and an open chat updates once per synced delete. Only deletes
  from your own other devices count.
- **Why**: User request (a delete made on one device should show on the others).
- **Pinned by**: core/services/deleteSync.test.ts (all groups: outgoing, incoming messages, incoming
  chat deletes, edited messages, tombstones, one store update, other chats and authors); core/backend/
  signal-cli/SignalCliBackend.test.ts :: describe "SignalCliBackend: delete for me sync" (sends the
  chat and each message as author and sent time; reports a deleteForMe from the user’s own device as a
  backend event); core/backend/signal-cli/normalise/normalise.test.ts :: describe "normaliseReceive:
  delete for me synced from the phone"; core/backend/signal-cli/capabilities.test.ts :: describe
  "supportsDeleteSync".
- **Not pinned**: the Java side in signal-cli patch 0027 and signal-service-java 0004 (they run in
  `scripts/build-signal-cli.sh --test`, not in Vitest).

---

## P. Composer

### P1. Esc always makes progress

- **Rule**: Each Esc in the composer takes the next step: close suggestions, cancel the reply, mark
  read (empty draft with something unread), otherwise move focus to the message list keeping the
  draft; it blurs if there is no list. Esc on the reply bar's Cancel button cancels the reply. While
  recording, Esc cancels the voice message (with Vim mode on as well) and focus goes to the composer,
  as the recorder's Cancel button does. Esc right after
  sending works too: the newest message becomes current.
- **Why**: Bug report: Esc did nothing with text typed and focus got trapped.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: goes autocomplete, reply, mark read,
  then leaves; moves focus to the message list and keeps the draft; leaves from an empty draft with
  nothing unread, without marking read; blurs the field when there is no message list to focus;
  Esc on the reply bar's Cancel button cancels the reply and returns to the field;
  ui/features/chat/composer/Composer.voice.test.tsx :: Cancel and Escape discard the recording and
  turn the microphone off, Escape too leaves focus in the composer; journeys/test_vim.py ::
  vim_escape_cancels_a_voice_recording; journeys/test_composer.py ::
  esc_on_the_cancel_reply_button_cancels_the_reply; journeys/test_keyboard.py :: esc_from_the_composer; journeys/
  test_keyboard.py :: esc_right_after_sending.

### P2. Composer buttons sit right of the field

- **Rule**: In order: Stickers, Emoji, then one "More options" menu last (Upload a file, Poll in groups
  only, Voice message with its shortcut shown only while nothing is staged). Nothing sits left of the
  field in either shell. Files can still be dragged or pasted.
- **Why**: Bug report: the mic button sat left of the field in the TUI shell.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: puts every button after the text field:
  Stickers, Emoji, then More options last; offers a file, a poll and a voice message in a group;
  offers no poll in a one-to-one chat, where Signal Desktop has none; leaves out the voice message
  while there is a draft to send; ui/features/chat/composer/StickerPicker.test.tsx :: puts the sticker
  button right before the emoji button; journeys/test_composer.py ::
  composer_buttons_sit_right_of_the_field, composer_buttons_sit_right_of_the_field_in_tui (by
  bounding boxes).
- **Not pinned**: nothing.

### P3. Enter sends

- **Rule**: Enter sends and Shift+Enter inserts a newline (swappable in settings); Enter is ignored
  during IME composition. The text is sent without its leading and trailing blanks and empty lines
  (an edit is saved the same way); a body that is only blanks sends no text, so it goes out with
  staged files and with nothing staged does nothing (the field is left as it was). Vim's Normal mode
  is not swapped by the setting (M13).
- **Why**: Signal parity and user request.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: sends on Enter and inserts a newline on
  Shift+Enter; swaps Enter and Shift+Enter with the setting; ignores Enter while an IME is composing
  (isComposing or keyCode 229); ui/features/chat/composer/Composer.test.tsx :: sends the text without its leading and
  trailing blanks and empty lines; sends no text with files when the body is only blanks, and nothing with
  neither; ui/features/chat/message/MessageEditor.test.tsx :: sends the edit without leading and trailing
  blanks and empty lines; closes without sending when only blanks were added; journeys/test_composer.py ::
  a_sent_message_is_trimmed, an_edit_is_trimmed_too.

### P4. Up in an empty composer edits your newest editable message

- **Rule**: Up in an empty composer edits your newest editable message, skipping stickers and
  messages past the window; it does nothing if all are past, or if there is text. A message still
  sending is skipped too, so Up edits the one before it.
  Up on the message that is already open in the editor goes back to it with what was typed. Text typed in
  an editor survives switching chats: coming back reopens the editor with it (only until the app
  closes; an editor nothing was typed in is simply closed). Saving or cancelling an edit puts focus in
  the composer, as Discord and Signal Desktop do (with Vim's navigation keys on, on the message list:
  M11). An edit open on a message that is deleted for everyone (here or from another device) closes
  with a "This message was deleted" toast; focus moves only if it was in the editor, to the message's
  row (a deleted message keeps its row), or to the composer when the row went too. Starting an edit of
  another message parks the first editor's typed text the way a chat switch does (`parkedDrafts`):
  editing the first message again reopens it with that text.
- **Why**: Signal parity, except for the sending message: Desktop opens the editor on it; here a
  message can't be edited until it has been sent (decided against matching Desktop). The rest: user
  decisions.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: edits the last own message with Up in
  an empty composer; opens the newest message that can be edited, skipping stickers and ones too old;
  opens nothing on ArrowUp when every own message is past the window; does not start editing when
  there is text; journeys/test_keyboard.py :: reply_then_edit (reply, then Up to edit it);
  edit_the_same_message_twice (the editor takes focus every time, also for the same message);
  core/stores/ui.test.ts :: gives every edit of the same message a session of its own;
  ui/features/chat/message/MessageEditor.test.tsx :: takes focus each time the same message is
  edited again; ui/features/chat/composer/Composer.test.tsx :: keeps the text typed in its editor (Up on the
  message being edited); closes, saying so, when it is deleted for everyone; closes, and focuses the
  composer, when the message is removed under the editor; core/stores/ui.test.ts :: comes back with its
  text when its chat is opened again; is dropped when nothing was typed, and stays when the same chat is
  opened again; ui/features/chat/message/MessageEditor.test.tsx :: is the composer after a save and after a
  cancel; journeys/test_keyboard.py :: saving_or_cancelling_an_edit_returns_focus_to_the_composer,
  unsaved_edit_text_survives_a_chat_switch, up_on_the_message_being_edited_keeps_its_text;
  journeys/test_delete.py :: edit_closes_when_its_message_is_deleted_on_another_device;
  core/stores/ui.test.ts :: keeps the typed text of an edit that gives way to the edit of another
  message; journeys/test_keyboard.py :: starting_another_edit_keeps_the_first_editors_text.
- **Not pinned**: skipping a message still sending; where focus lands in a restored edit (the editor
  reopens, but opening a chat moves focus as it always does); the "row went" focus is a unit test only.

### P5. A failed send restores the draft

- **Rule**: Words, files and reply come back when a send throws before staging (and for a sticker
  send); text typed meanwhile is not overwritten. If the send fails after staging, the failed message
  stays instead of a restored draft.
- **Why**: Data safety; bug reports.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: puts the words, the files and the reply
  back when a send throws; does not overwrite what was typed while a failing send was out; leaves the
  failed message, not a restored draft, when the send fails after staging it; ui/features/chat/
  composer/StickerPicker.test.tsx :: puts the reply back when the sticker send throws before anything
  is staged.

### P5a. A reply follows its message

- **Rule**: A reply ends when its message is deleted (for you, for everyone, expired, here or from
  another device): the bar goes, the draft stays. A message that only leaves the loaded window
  (scrolled far away, or its chat's window closed) keeps the reply and its quote: the bar and the
  quote use the copy kept when the reply began. A reply is never sent without its quote while the bar
  shows one; if the message is gone at send time, nothing is sent, the reply is cancelled and the
  draft stays.
- **Why**: Bug report: "Replying to Unknown contact", and the reply went out with no quote.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: cancels the reply, and keeps the draft,
  when its message is removed; cancels the reply when its message is deleted for everyone; keeps the
  reply, and its quote, when its message only leaves the loaded window; never sends without its quote
  while the bar shows a reply; journeys/test_composer.py ::
  reply_bar_goes_when_its_message_is_deleted.
- **Not pinned**: a message deleted on another device while its chat's window is closed (nothing here
  sees that delete; the reply stays and sends its kept quote).

### P6. Suggestions

- **Rule**: `@` suggests members, `:` emoji, `/` commands. Tab or Enter accepts, but Ctrl+Tab does not;
  Esc dismisses and it stays closed while typing on; in Vim mode suggestions show only in Insert.
  They open only from the user's own typing or caret move in the focused field (the composer and the
  inline editor alike): never for text that was already there, such as a restored draft ending in
  `@`, and they close when the field loses focus, staying shut until the next typing or caret move.
  Clicking an option does not count as leaving.
- **Why**: Bug report.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: accepts a member mention with Tab and
  sends it as a mention range; does not accept a suggestion on Ctrl+Tab, only on a plain Tab; dismisses
  autocomplete with Escape and keeps it closed while typing on; suggests slash commands from the
  registry; closes when focus leaves the field, and waits for typing or the caret before reopening;
  stays shut for a draft that ends in a trigger until the user types; ui/features/chat/message/
  MessageEditor.test.tsx :: opens suggestions only from typing in the focused field; journeys/
  test_composer.py :: suggestions_close_when_focus_leaves_the_composer;
  suggestions_stay_shut_when_a_draft_comes_back.
- **Not pinned**: Ctrl, Cmd and Alt+Enter not accepting a suggestion; a case in `Composer.test.tsx`
  would pin it.

### P7. Drafts

- **Rule**: Drafts persist per conversation. Staged files are part of the draft: they are still there
  when the user switches chats and comes back, and go out when it is sent. Text and the mentions
  picked for it are saved on the device and survive a restart; files are kept in memory for the session
  only (a File cannot be stored with the text), so a restart drops them. A staged file's preview stays
  valid while the chat is away; sending or removing the file releases it. Removing a staged file puts
  focus in the composer. A dismissed link preview stays dismissed for that URL while composing and
  returns when the URL leaves the text and is pasted again.
- **Why**: Plan; bug report.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: persists the draft per conversation;
  ui/features/chat/composer/chatSmallFixes.test.tsx :: forgets a dismissed link once it is out of the
  text, so pasting it again previews it; ui/features/chat/composer/ComposerLinkPreview.test.tsx ::
  dismisses the card, which stays hidden for that url while composing; ui/features/chat/composer/Composer.test.tsx :: keeps staged files when the user leaves the chat
  and comes back; puts focus in the composer when a staged file is removed; ui/features/chat/composer/
  useAttachments.test.ts :: keeps what is staged for the chat while it is away, previews still valid;
  journeys/test_composer.py :: staged_file_survives_a_chat_switch,
  staged_image_keeps_its_preview_across_a_chat_switch, a_staged_file_is_sent_once_and_not_staged_again,
  removing_a_staged_file_puts_focus_in_the_composer.
- **Not pinned**: files across an app restart (dropped by design).

### P8. Link previews when sending

- **Rule**: On by default (including existing installs). The desktop fetches the first link's title,
  description and image as you type and sends it. Nothing is fetched when the phone has previews off
  (even if the local setting is on) or while the phone's value is still being read; no preview on
  messages with files; edits carry the preview, refreshed or dropped when the link changes.
- **Why**: Signal parity; an old default was wrong.
- **Pinned by**: ui/features/chat/composer/ComposerLinkPreview.test.tsx (all); core/stores/
  settings.test.ts :: defaults linkPreviews to on; migrates v3 settings to v4, turning linkPreviews
  on; core/services/services.test.ts :: drops the preview, for everyone, when the edit removes its
  link; ui/features/chat/message/MessageEditor.test.tsx (preview cases).

### P9. Attachment limits

- **Rule**: The limit is 100 MB. Oversize or empty files are refused when attached (a mixed drop keeps
  the valid ones) and again before forwarding or staging, with a message naming up to three files.
- **Why**: Bug: rows and blobs were stored for files that could never go out.
- **Pinned by**: core/domain/limits.test.ts (all); ui/features/chat/composer/Composer.test.tsx ::
  refuses a too-large file with a message and keeps the rest of the drop; adds no attachment for an
  empty file, and counts many refused files; core/services/services.test.ts :: refuses an oversize or
  empty file before staging anything.

### P10. Paste

- **Rule**: Ordinary text paste is left to the browser. Web links stay text even when the clipboard
  advertises a URI list. Files paste only from a native gesture (Linux native read), never twice;
  native clipboard errors surface without attachments. Pasting with an ownerless clipboard does not
  crash the app.
- **Why**: Security audit; a crash bug.
- **Pinned by**: ui/features/chat/composer/Composer.test.tsx :: does not read the native clipboard for
  ordinary text; keeps copied web links as text even when they advertise a URI list; surfaces native
  clipboard errors without adding attachments; does not attach a file twice when both clipboard lists
  expose it; src-tauri/src/paste_gate.rs :: closed_until_a_gesture_opens_it; src-tauri/src/
  gtk_clipboard_guard.rs :: a_failed_request_reaches_the_caller_as_no_targets.
- **Not pinned**: the real WebKitGTK crash end to end (only the guard function is tested).

### P11. Stickers in the composer

- **Rule**: The sticker button opens a picker (Recent first, then installed packs). Clicking sends at
  once (optimistic, outbox, retry), honours an active reply and leaves the draft. It is hidden when
  the backend cannot list packs; a received sticker's pack dialog can install the pack; recent stickers
  are stored as identifiers only.
- **Why**: Feature request.
- **Pinned by**: ui/features/chat/composer/StickerPicker.test.tsx (all); ui/features/chat/message/
  StickerPackDialog.test.tsx (all); core/stores/local.test.ts :: keeps the most recent stickers first,
  once each, capped.

### P12. Polls

- **Rule**: Create from More options in groups only (not 1:1); 2 to 10 options, question up to 100
  characters, option up to 100 UTF-16 units; Send disabled until typed. Vote and end are optimistic
  with rollback; only the author ends a poll (after asking); the latest vote wins by `voteCount`; a
  half-written poll is kept when the dialog closes and forgotten once sent; Ctrl+Enter sends.
- **Why**: Signal Desktop parity.
- **Pinned by**: ui/features/chat/composer/PollCreateDialog.test.tsx (all); ui/features/chat/
  composer/pollDraft.test.ts (all); core/domain/poll.test.ts (all); core/services/polls.test.ts (all);
  ui/features/chat/message/PollCard.test.tsx; ui/features/chat/message/MessageItem.poll.test.tsx.

### P13. Voice notes

- **Rule**: The mic in an empty composer (and Mod+Shift+Y) records a mono MP3 (96 kbit/s, LAME wasm)
  with a timer, live levels and Cancel/Send, up to one hour; Esc cancels; the microphone is released
  on stop, cancel or leaving. Losing window focus keeps the recording as a draft; it sends as a Signal
  voice message; a file next to a voice draft is refused.
- **Why**: Signal parity.
- **Pinned by**: ui/features/chat/composer/Composer.voice.test.tsx (all); ui/features/chat/voice/
  recorder.test.ts, useVoiceRecorder.test.tsx and mp3Encoder.test.ts.
  journeys/test_composer.py :: voice_message_waits_for_the_permission_and_cancels (the recorder's
  starting state, Send off, Esc cancels), voice_message_refused_microphone_says_so (a denied
  permission, from the shortcut and the menu).
- **Not pinned**: a real recording (the runner has no microphone) and the AudioWorklet at runtime;
  `src-tauri/src/mic_gate.rs` has unit tests for the gate only.

### P14. Custom emoji and emoticons

- **Rule**: `:name:` autocompletes, inserts as `:name:` and renders inline (jumbo when alone). Text
  emoticons insert their text; a hand-typed `:name:` expands at send before markdown and mention
  ranges. Other Snowdrop users get the emoji through a hidden field (official apps see `:name:`).
  Received custom emoji can be added ("Add to my emoji") with name-clash rename and duplicate
  detection, never overwriting; the 32-entry cap is shared.
- **Why**: User request.
- **Pinned by**: core/stores/customEmoji.test.ts (all); ui/features/chat/composer/
  CustomEmojiPanel.test.tsx (all four); ui/features/chat/message/CustomEmojiCard.test.tsx (all);
  core/services/services.test.ts :: includes the sender own custom emoji used in the text, when the
  backend supports delivering them; never attaches customEmoji when the backend has not advertised
  support for it; ui/features/settings/pages/CustomEmojiPage.test.tsx.

### P15. Markdown and mentions

- **Rule**: CommonMark-style inline styles (bold, italic, strike, mono, spoiler `||`); `~~` and `||`
  never intraword; fenced code; URLs atomic. Offsets are UTF-16 code units (Signal's wire units); body
  ranges are capped at 500; mentions attach after markdown parsing; the draft format is honoured
  regardless of the markdown setting. Only a member picked from the "@" list is a mention: a typed
  "@Name" is plain text. The picked mentions are saved with the draft (not worked out again from its
  text), so a restored draft has exactly the mentions it had; emptying the field forgets them.
- **Why**: Plan; security audit.
- **Pinned by**: core/domain/markdown.test.ts (all); core/domain/segments.test.ts (all);
  core/services/services.test.ts :: attaches mentions after markdown parsing; honours the draft
  format regardless of the markdown setting; ui/features/chat/composer/Composer.test.tsx :: sends a typed @Name as plain text, and a
  restored draft as it was; keeps the mentions picked from the list with the draft; forgets the picked
  mentions when the draft is emptied; core/stores/local.test.ts :: keeps the mentions picked for a
  draft, and drops them with it; round-trips a draft with its picked mentions, and ignores malformed
  ones; journeys/test_composer.py :: picked_mention_stays_a_mention_when_the_draft_comes_back,
  typed_name_stays_plain_text_even_when_the_draft_comes_back.

### P16. The wheel stays inside a popover

- **Rule**: A wheel over a popover, picker, suggestion list or menu scrolls that surface's own scroll
  area and nothing behind it, also at the end of its range (like `overscroll-behavior: contain`, which
  WebKit's threaded scrolling bypassed: on a touchpad the chat behind the sticker picker scrolled and
  the picker did not). `useContainedWheel` puts a non-passive `wheel` listener on the surface (the
  `Popover`, `EmojiPickerPopover` and `Menu` primitives, the autocomplete list), which scrolls the
  nearest scrollable element under the pointer itself. Pinch zoom (ctrl) and mostly sideways wheels
  are left alone; mouse-wheel steps jump instead of animating.
- **Why**: User report (installed app, touchpad).
- **Pinned by**: ui/hooks/useContainedWheel.test.tsx (all); journeys/test_composer.py ::
  wheel_over_the_sticker_picker_scrolls_it_not_the_chat (passes on the old code too: the harness's
  synthetic events cannot reproduce the routing bug).
- **Not pinned**: the routing on a real touchpad; modals' own lists (their overlay covers the page).

### P17. A clicked text field has a caret

- **Rule**: A click into a text field leaves a caret in it, so typing goes in. Above 100% zoom (the Zoom
  setting or WebKit's own page zoom), WebKitGTK focuses a textarea or input clicked from elsewhere
  without placing a selection, and keys then insert nothing. `useCaretOnClick` (called by `App`)
  checks on mouseup: a clicked text field with focus and no selection gets its caret at the end of
  its text, where a programmatic focus puts it.
- **Why**: Found by the zoom journeys (T18): at 125% the composer took focus from a click and dropped
  every key.
- **Pinned by**: ui/hooks/useCaretOnClick.test.tsx (all); journeys/test_appearance.py ::
  clicking_the_composer_zoomed_in_places_the_caret.
- **Not pinned**: where in the text a zoomed click puts the caret when the field already had one (the
  click is WebKit's).

---

## N. Notifications and catch-up

### N1. Hold notifications during catch-up

- **Rule**: From each server connect (initial, reconnect, wake) until the queue is empty, no
  notification is shown. Every move into online from any other state (after the first connect) is a
  connect, whether the stream was offline, reconnecting or in error; the first connect starts one
  catch-up, not two. When the backend sends `caughtUp` (builds 21 and later, ordered from 23) the
  hold ends only on `caughtUp` or a 2-minute ceiling (no quiet period), and a `caughtUp` from an
  earlier connection or a timer from before a sleep cannot end a newer hold. Hold starts and ends are
  logged with reason and counts only.
- **Why**: Bug report: a flood of notifications after waking from sleep.
- **Pinned by**: core/services/catchUp.test.ts (all); core/services/NotificationService.test.ts ::
  silences messages processed while notifications are held for a catch-up; stays silent while
  notifications are held for a catch-up, then speaks again; core/services/eventPipeline.test.ts ::
  keeps holding notifications while the queue is still working through the backlog; core/backend/
  signal-cli/SignalCliBackend.test.ts (catchingUp ordering cases, see G1).
  journeys/test_notifications.py :: notifications_wait_for_the_end_of_catch_up (a held catch-up at
  launch and a later one: nothing shown, nothing replayed, the next message shown);
  core/services/catchUp.test.ts :: a brief drop that only reports connecting before coming back holds
  notifications too; the first connect starts one catch-up, not a second one when the stream reports
  online; journeys/test_catch_up.py :: a_brief_drop_starts_a_catch_up_too.
- **Not pinned**: the real wake-from-sleep flood with a live signal-cli backlog; a journey against a
  real signal-cli would pin it.

### N2. The notification hold and the sidebar freeze are one flag pair

- **Rule**: `NotificationService` reads `notificationsHeld` only; `notificationsHeld` is always equal
  to `catchingUp` because one tracker sets both (S2). A catch-up never ends for the sidebar before it
  ends for notifications, or the other way round.
- **Why**: Bug report (S2): two trackers once ended at different times.
- **Pinned by**: core/services/catchUp.test.ts :: with the capability the sidebar and the hold both
  last past the short ceiling, up to the long one; core/services/NotificationService.test.ts :: only
  the notification hold decides, not the sidebar catch-up flag.

### N3. Notification dating

- **Rule**: A replayed envelope is dated by when the server received it (memory only), falling back to
  the sender's clock; the same for reactions and poll activity. Notifications arriving before the
  notification plugin has loaded wait for it.
- **Why**: Bug: old messages notified after a backlog.
- **Pinned by**: core/services/NotificationService.test.ts :: dates a message by when the server got
  it, not by the sender’s clock; dates a reaction and a poll vote by when the server got it; silences
  initial sync and old envelopes delivered after sync finishes; app/desktopNotifications.test.ts ::
  holds a notification shown before the plugin has loaded and delivers it once it has.

### N4. Who gets notified

- **Rule**: Never for own, system or deleted messages. The master switch and the "nothing" mode apply;
  muted chats and spaces let only mentions and boosts through; mentions-only mode needs a mention in
  groups (DMs still notify). It stays quiet for the conversation you are looking at (focused, visible
  and at the bottom) and notifies for the open chat when the window is hidden.
- **Why**: Signal parity.
- **Pinned by**: core/services/NotificationService.test.ts :: never notifies for own, system or deleted
  messages, or without permission; respects the master switch and the "nothing" mode; stays quiet for
  the conversation you are looking at (focused + visible + at the bottom); notifies for the open
  conversation when the tab is hidden; muted conversations (with expiry) and spaces only let mentions
  and boosts through; mentions-only mode: groups need a mention or boost; DMs still notify;
  journeys/test_notifications.py :: looking_at_a_chat_is_quiet (real window focus events and scroll
  position).
- **Not pinned**: the desktop notification itself (the journey records what the page asks for).

### N5. Notification content

- **Rule**: Group title and author prefix; an attachment-only message reads "Photo", "Voice message"
  or the file name; previews off hides the text; a message request shows the sender and "Message
  Request", never the text; spoilers are masked.
- **Why**: Signal Desktop parity.
- **Pinned by**: core/services/NotificationService.test.ts :: notifies for a new message with group
  title and author prefix; summarises attachment-only messages; shows the sender and "Message
  Request", never the text, for an unaccepted direct chat; hides text when previews are off and never
  reveals spoilers; names the sender and the group in the title for an unaccepted group.

### N6. Reaction and poll notifications

- **Rule**: Reactions and votes on your messages notify under the message rules, with Signal Desktop's
  wording; the notification is withdrawn when the reaction is removed or replaced; your own votes and
  retractions are silent.
- **Why**: Feature request.
- **Pinned by**: core/services/NotificationService.test.ts :: names the reactor, the emoji and the
  message that was reacted to; withdraws it when the reaction is taken back; withdraws it when the
  reaction is replaced, and announces the new one; stays silent for old news, our own reactions,
  deleted messages and missing permission; names the voter and the question when someone votes on a
  poll of yours; core/services/activity.test.ts :: announces a reaction while the user is away and
  withdraws it when the phone reads it.

### N7. Notifications close when no longer valid

- **Rule**: A notification closes when the chat is read here or on the phone, or the message is
  deleted or expires. A read of an older message leaves a newer message's notification up. There is
  one notification per conversation, replaced by the next.
- **Why**: Feature request.
- **Pinned by**: core/services/NotificationService.test.ts :: closes a message notification once the
  chat is read past it, here or on the phone; leaves a newer message’s notification when an older one
  is read; closes the notification of a message that was deleted or expired; replaces the previous
  notification of a conversation; platform/tauri/notifications.test.ts (all seven); src-tauri/src/
  notifications.rs (unit tests).

### N8. Clicking a notification does nothing on the desktop

- **Rule**: On the desktop (Tauri) a notification only informs: clicking it does not open the
  conversation. The conversation is a click away in the app.
- **Why**: A click-to-open implementation was added and reverted as not requested; the desktop
  adapter's own documentation says clicks are unsupported.
- **Pinned by**: platform/tauri/notifications.test.ts :: only informs: the click handler is never
  called or passed on (N8).
- **Not pinned**: a click on a real desktop notification. The service's `onClick` hook, which the
  in-browser `Notification` adapter wires (`n.onclick`), is pinned by core/services/
  NotificationService.test.ts :: clicking focuses the window and opens the conversation in its
  space; it is a different layer and does not conflict with this rule (see Conflicts checked).

### N9. Notification permission UI

- **Rule**: Settings > Notifications uses desktop wording, follows the permission live (and re-checks
  on window focus), and names a missing notification service only when the platform call failed.
- **Why**: Bug report.
- **Pinned by**: ui/features/settings/pages/NotificationsPage.test.tsx (all eight).

### N10. Startup steps run after every connect

- **Rule**: Notifications, plugins, outbox restore and history import run after every successful
  connect, each isolated, so a failing step does not stop the others; Retry actually reconnects; the
  startup hold is sized once signal-cli's version is known.
- **Why**: Bug: Retry returned the cached success and skipped the steps.
- **Pinned by**: app/createSnowdrop.test.ts :: runs every post-connect step when a Retry succeeds after
  a failed first connect; does not skip the other steps when one of them fails; core/services/
  PostConnect.test.ts (all); core/services/catchUp.test.ts :: is strict, with the long ceiling, on a
  build that orders catchingUp, though the version is only known after connecting.

### N11. Unread count to tray and title is debounced

- **Rule**: The unread count sent to the tray and window title is debounced and sent only on change.
- **Why**: Performance.
- **Pinned by**: app/unreadSync.test.ts (all four).

---

## D. Media, attachments, gallery, avatars

### D1. Expired attachments ask the phone only on click

- **Rule**: An expired or missing attachment (chat, gallery) shows "Not on this device" with "Get from
  phone". Only the click asks the phone: at most three requests outstanding, about a 2-minute wait;
  Retry asks again. Forwarding still asks (a user action).
- **Why**: Bug report: opening the gallery sent a burst of backfill requests and phone notifications.
- **Pinned by**: ui/features/chat/message/Attachments.test.tsx :: a photo shows "Get from phone", asks
  nothing until clicked, then asks once and waits; a file card offers the same action and also asks
  nothing on render; ui/features/chat/message/useAttachmentUrl.test.tsx :: requests nothing on render,
  and exactly once per click; holds back clicks beyond the concurrency limit until an answer frees a
  place; times out ~2 minutes after asking, with no answer at all; leaves the spinner at once and
  Retry asks the phone again; backfillGate.test.ts; ui/features/chat/gallery/GalleryPanel.test.tsx ::
  shows a compact state, asks nothing on mount, and only the viewer button asks.

### D2. Failed downloads can be retried

- **Rule**: Retry bypasses the cached result and is shown only where it can help. A media load error
  re-resolves once, then shows Retry; audio Retry brings the voice player back.
- **Why**: Bug: dead blob URLs were shown as ready.
- **Pinned by**: ui/features/chat/message/Attachments.test.tsx :: an <img> onError re-asks the backend,
  and shows Retry once that re-ask also fails; brings the voice player back when Retry succeeds after
  a failed download; ui/features/chat/message/useAttachmentUrl.test.tsx :: retry() re-resolves through
  the backend rather than any cached value; ui/features/chat/lib/lib.test.ts :: shows no Retry for
  permanent failures; offers Retry for failures another attempt could plausibly fix.

### D3. Full-quality sent images

- **Rule**: Sent images keep their original in the encrypted local store; the viewer shows it and
  forwarding sends it. In-chat previews are sized for screen pixel density. "Free up space" in
  Settings > Data & storage removes originals older than 30 or 90 days, a year, or all, after a
  confirm that says how much; nothing happens automatically.
- **Why**: User request.
- **Pinned by**: ui/features/chat/message/useViewerAttachment.test.tsx (all); core/backend/
  thumbnail.test.ts; ui/features/settings/pages/SentPhotosRows.test.tsx (all); ui/features/forward/
  media.test.ts :: sends the original when it is kept.

### D4. Voice note playback

- **Rule**: Received voice notes get a player (locally computed waveform, scrub, speeds, unplayed dot,
  autoplay of the next note). Playback continues when scrolled away or switching chats, with a mini
  player under the chat header; it stops on delete, expiry, sign-out and lock. Unnamed audio counts as
  a voice note (older Android).
- **Why**: Signal Desktop parity; user request.
- **Pinned by**: ui/features/chat/voice/voicePlayback.test.ts, VoicePlayer, MiniPlayer,
  playbackGuard.test.tsx, nextVoice and voiceTrack tests (all); ui/features/chat/ConversationArea.test.tsx
  :: leaves the playing voice note alone when the conversation closes; ui/features/chat/message/
  Attachments.test.tsx :: treats audio with no file name as a voice note (older Android clients);
  core/domain/voiceNote.test.ts.

### D5. Gallery

- **Rule**: Media, Audio, Links and Files tabs, grouped by Today, Yesterday, This Week and This Month,
  then by month (midnight belongs to the later day). It opens from the header, the details popover or
  the palette, beside the chat (a drawer when narrow), exclusive with search; updates live while open;
  "go to message"; thumbnails load only near the viewport; no file is fetched until Download; a note
  shows while history is still importing.
- **Why**: Signal Desktop parity; user request.
- **Pinned by**: ui/features/chat/gallery/GalleryPanel.test.tsx (all); ui/features/chat/gallery/
  galleryLive.test.ts (all); core/domain/gallery.test.ts (all).

### D6. Avatars

- **Rule**: Real contact, group and own avatars; a contact photo is preferred over a profile photo.
  They load lazily for what is on screen (one shared observer), at most three calls at a time,
  deduplicated, cached in memory only and invalidated when a profile or group changes. A stranger's
  photo is not fetched until the request is accepted ("View photo" reveals it); initials are the
  fallback; transparent avatars flatten onto white; your own and group photos survive a restart.
- **Why**: Feature request; Signal Desktop parity.
- **Pinned by**: ui/hooks/useAvatarSrc.test.tsx (all); core/backend/signal-cli/avatars.test.ts (all);
  core/backend/signal-cli/SignalCliBackend.avatars.test.ts (all); ui/features/conversation/
  PersonAvatar.test.tsx (all); ui/lib/avatarImage.test.ts :: flattens transparency onto white before
  drawing, so it does not turn black as a JPEG.

### D7. Message request media gate

- **Rule**: Until a request is accepted, others' media, stickers, avatar photos and link-preview images
  wait behind a Download action and links are inert. Your own media and accepted chats are never held;
  accepting resolves everything at once.
- **Why**: Signal parity.
- **Pinned by**: ui/features/chat/message/messageRequestMedia.test.tsx (all twelve).

### D8. Attachment cache

- **Rule**: Object URLs are evicted past 64 MB or 200 entries but never while a mounted component
  retains one; an unmounted tile aborts its download.
- **Why**: Memory.
- **Pinned by**: core/backend/signal-cli/params.test.ts :: evicts least-recently-used entries over the
  byte budget, skipping ones still in use; still evicts by entry count under the byte budget; a single
  file larger than the whole budget is kept while retained, and evicted on release; ui/features/chat/
  message/useAttachmentUrl.test.tsx :: retains on mount and releases on unmount, once each,
  regardless of retries; aborts the download when the tile unmounts.
- **Not pinned**: the shipped 64 MB and 200 constants; a test importing them would pin them.

### D9. Link preview fetching (Rust)

- **Rule**: https only; every resolved address and every redirect is checked against private,
  loopback, link-local, mapped, NAT64, 6to4 and Teredo ranges. Only `HTTPS_PROXY` / `https_proxy` is
  honoured (no local DNS with a proxy; the proxy refuses private targets; an unusable proxy fails
  rather than going direct). One deadline covers the whole redirect chain; size caps; at most four at
  once; the page's declared charset is decoded (BOM, Content-Type, meta in the first 1024 bytes, else
  UTF-8); Signal's preview User-Agent.
- **Why**: Security audit; Signal parity.
- **Pinned by**: src-tauri/src/link_preview.rs :: decodes_the_page_in_its_declared_charset;
  a_configured_proxy_is_never_asked_for_local_or_private_targets; the_deadline_covers_the_whole_
  redirect_chain; an_unusable_proxy_value_fails_instead_of_going_direct (and the other unit tests in
  that file).
- **Not pinned**: at most four fetches at once; a Rust test with a gated fake fetcher would pin it.

### D10. No link-preview fetch in the browser build

- **Rule**: The browser build never fetches link previews, and the setting is hidden where the backend
  has no `link_preview_fetch`.
- **Why**: Design: fetching needs the desktop shell's guarded network access.
- **Pinned by**: ui/features/settings/pages/BehaviourPage.test.tsx :: is not offered when the backend
  has no link_preview_fetch (the browser build).

---

## T. Settings, themes, appearance, safe mode

### T1. Safe mode

- **Rule**: `snowdrop --safe` starts the desktop app without imported themes and Custom CSS (a second
  launch with `--safe` reloads the running window in safe mode); the browser build uses `?safe=1`.
  Safe mode lasts until Snowdrop is opened normally again (a reload keeps it). Holding Shift never
  triggers it.
- **Why**: User request (a broken theme could not be escaped); bug (window-manager shortcuts
  triggered the Shift trap).
- **Pinned by**: src-tauri/src/lib.rs :: safe_mode_only_with_the_exact_flag;
  safe_mode_url_replaces_the_query_and_keeps_the_page; ui/features/settings/themes/
  SafeModeHint.test.tsx (both); app/installBootHelpers.test.ts :: shows the safe-mode toast when
  started in safe mode; never reloads into safe mode from the keyboard or pointer.
- **Not pinned**: the second launch reloading the running window and a reload keeping safe mode; a
  desktop end-to-end test would pin them.

### T2. Theme import trial

- **Rule**: A theme with CSS goes on probation and stays only on Keep; leaving the Themes page
  mid-trial reverts it and puts back the theme an import replaced.
- **Why**: Bug report.
- **Pinned by**: ui/features/settings/themes/ThemesPage.test.tsx (all three).

### T3. Theme and CSS sanitising

- **Rule**: Remote `@import`, `url()`, `image-set()` and `src()` (also through `var()`) are removed;
  themes and Custom CSS make no remote fetches; unknown tokens are rejected; accent text moves to
  4.5:1 contrast.
- **Why**: Security design.
- **Pinned by**: core/themes/sanitize.test.ts (all); core/themes/custom.test.ts (all);
  test/themeExport.test.ts; test/contrast.test.ts (all); test/tokens-sync.test.ts;
  test/styleHooks.test.ts.

### T4. Theme style tags stay put

- **Rule**: Theme style tags are not detached and re-added on every apply.
- **Why**: Bug: a WebKitGTK repaint problem left the chat on the old theme.
- **Pinned by**: core/themes/themes.test.ts :: does not reposition its style tags when nothing has
  displaced them.
  journeys/test_appearance.py :: theme_switch_keeps_style_tags_and_repaints (no tag moves on a
  switch with nothing displaced; the painted pixel follows each theme).
- **Not pinned**: the rare WebKitGTK stale paint itself, which never reproduced on demand.

### T5. TUI layout

- **Rule**: Settings > Appearance > Layout > TUI boxes every region with a titled border (the member, search and media sheets of a narrow window too: inset from the window's edge, title whole), monospace,
  square corners, one message per line in aligned columns, and a status line (conversation, unread,
  connection, Vim mode). Jump-to-latest and new-messages are small corner chips; unread counts read
  `[3]`; the standard shell is unaffected; boot paints the mirrored shell with no flash.
- **Why**: User request, then many alignment bug reports.
- **Pinned by**: core/themes/themes.test.ts :: sets data-shell="tui" only for the TUI shell;
  app/bootAppearance.test.ts (all three); ui/features/shell/StatusLine.test.tsx (all three); core/
  stores/settings.test.ts :: defaults the TUI shell to standard; core/plugins/api.p6.test.ts ::
  registers and tears down a status-line item.
  journeys/test_appearance.py :: tui_regions_are_boxed_and_titled, tui_messages_sit_in_aligned_columns,
  tui_jump_chip_sits_in_the_corner, tui_side_sheets_are_inset_panes_with_whole_titles.
- **Not pinned**: the boot paint with no flash (it happens before the runner can look).

### T6. Font size

- **Rule**: `appearance.fontSize` runs from 12 to 20 px (default 15), sets message text and scales the
  interface; the old `fontScale` setting migrates; zoom stays a percentage; the TUI has its own smaller
  sizes (message text 13 px) scaled by the same setting.
- **Why**: User request.
- **Pinned by**: core/stores/settings.test.ts :: parses fontSize, clamping to 12-20 and rounding to a
  whole pixel; migrates v4 settings to v5.
- **Not pinned**: the TUI's own sizes (CSS).

### T7. Focus-composer-on-open is off by default

- **Rule**: "Focus the message box when opening a conversation" is off by default; opening focuses the
  message list's current row (or keeps the sidebar row).
- **Why**: User request.
- **Pinned by**: core/stores/settings.test.ts :: defaults focusComposerOnOpen to off; test/
  shell.test.tsx :: highlights matches, opens with Enter and focuses the message list; focuses the
  composer instead when "Focus the message box…" is on.

### T8. Settings search finds every row

- **Rule**: Every settings row has an index entry, there are no stale entries, and every section
  rendered by id has one.
- **Why**: Bug report.
- **Pinned by**: ui/features/settings/pagesIndex.test.ts (all); ui/features/settings/search.test.ts.

### T9. Phone-following settings show their effective value

- **Rule**: Settings that follow the phone show the effective value and whether they follow the phone;
  changes write back to the phone, not to the local setting.
- **Why**: One source of truth for the privacy settings (V1).
- **Pinned by**: ui/features/settings/pages/PrivacyPage.test.tsx (phone-value cases); ui/features/
  settings/pages/BehaviourPage.test.tsx :: shows the phone’s value and writes a change back to it, not
  to the local setting.

### T10. Close to tray

- **Rule**: Closing the window keeps Snowdrop in the tray when "Close to tray" is on (the default) and
  a tray exists; the setting is shown only when a tray exists. Quit in the tray menu runs the normal
  close handshake.
- **Why**: User request.
- **Pinned by**: core/stores/settings.test.ts :: defaults closeToTray to on; ui/features/settings/
  pages/BehaviourPage.test.tsx (tray cases); src-tauri/src/tray.rs ::
  close_decision_hides_only_with_a_tray_and_the_setting_both_on.
- **Not pinned**: the Rust-side default is off until the frontend mirrors the setting (see Conflicts
  checked); a test of the first-close path before `createSnowdrop` mirrors it would pin the decision.

### T11. Start in tray

- **Rule**: `--start-in-tray` creates the window hidden only if a tray exists; a relaunch without the
  flag shows it; a relaunch with it does nothing.
- **Why**: Signal Desktop parity.
- **Pinned by**: src-tauri/src/tray.rs :: starts_hidden_only_with_the_flag_and_a_tray.
- **Not pinned**: the relaunch behaviour; a desktop end-to-end test would pin it.

### T12. Tray badge

- **Rule**: The unread total (muted excluded) shows as a red badge with a digit, "9+" from ten; the
  taskbar badge and "Snowdrop (3)" window title follow where supported; every tray command is
  registered.
- **Why**: User request; bug: the commands were defined but not registered.
- **Pinned by**: src-tauri/src/tray.rs (badge label and render tests); src-tauri/src/commands.rs ::
  registers_every_command_the_ui_invokes.

### T13. Plugins

- **Rule**: A plugin's crash is contained per plugin (failure chip, retry); a failing plugin never
  stops others or the app. Vim mode, Clear URLs, Silent Typing, Keyword Alerts and Slash Basics are
  built in; Silent Typing migrates to `sendTypingIndicators`.
- **Why**: Plan (plugin platform).
- **Pinned by**: core/plugins/plugins.test.ts; core/plugins/api.p6.test.ts; ui/features/settings/
  plugins/*.test.tsx; core/stores/settings.p4.test.ts.

### T14. Render errors are contained to the area

- **Rule**: A render error in the sidebar, chat, members, a dialog or a settings page shows "Something
  went wrong showing …" with Try again in that area; chat and members reset when another conversation
  opens. The root boundary is the last resort, with Reload and Copy details.
- **Why**: User request after a whole-window crash.
- **Pinned by**: ui/lib/AreaErrorBoundary.test.tsx (all nine); ui/features/shell/
  AppShell.areas.test.tsx; ui/features/shell/ModalHost.areas.test.tsx; ui/features/settings/
  SettingsOverlay.areas.test.tsx; app/AppErrorBoundary.test.tsx (all six).
- **Not pinned**: the chat header, mini player and connection banner having their own error areas; a
  component test throwing in each would pin them.

### T15. The link screen works with a frozen `Object.prototype`

- **Rule**: The device-link screen draws its QR code with `uqr`, which works with a frozen prototype
  (`qrcode` threw there).
- **Why**: User bug: a blank window in the production build.
- **Pinned by**: ui/primitives/QrCode.frozen.test.ts :: imports and encodes a realistic link URI
  without throwing (child Node process with a frozen prototype). Journeys also run the production
  build with a frozen prototype.

### T16. Diagnostics

- **Rule**: Settings > Data & storage > Diagnostics has a verbose-logging switch, copy recent log and
  open log folder (desktop only). Logs never contain message text, names, numbers or keys. The stall
  detector logs "UI stalled <ms>" past 500 ms using a timer heartbeat, not a rAF loop (which kept idle
  CPU near 25%).
- **Why**: User request; a performance bug.
- **Pinned by**: ui/features/settings/pages/DataPage.test.tsx (diagnostics cases); app/perf.test.ts
  (all five); src-tauri/src/redact.rs (unit tests).
- **Not pinned**: the idle-CPU rule itself; a journey measuring idle CPU would pin it.

### T17. Onboarding copy

- **Rule**: The desktop app links as "Snowdrop" (not "Snowdrop (Safari on Linux)") and says "window"
  not "tab". Signing in to a Signal account is the primary choice; the demo is a small secondary link
  with a persistent demo banner.
- **Why**: User request.
- **Pinned by**: ui/features/onboarding/linkFlow.test.ts :: is plain "Snowdrop" in the desktop app,
  whatever the user agent says; ui/features/onboarding/LinkDevice.test.tsx (tab and window cases);
  ui/features/onboarding/Welcome.test.tsx (both); ui/features/shell/DemoBanner.test.tsx (all three).

### T18. The page fills the window at any zoom

- **Rule**: Zoom (0.8 to 1.5) is a CSS `zoom` on `html`. The page is exactly the window at every zoom:
  no page scroll, the composer at the window's bottom edge. Nothing sizes the page or a surface with
  `vw`, `vh` or `dvh` (window px, which the zoom scales again; `body { min-height: 100dvh }` made the
  page 1.25 windows tall at 125%): the stylesheets use `calc(N * var(--snowdrop-vh))` and
  `--snowdrop-vw` (a window percent in layout px). Radix (and the autocomplete list) place a surface
  with a translate in window px, so the placement wrapper is un-zoomed and the surface inside it
  zoomed back (`[data-radix-popper-content-wrapper]` in `styles/global.css`); Radix's available height
  is divided by the zoom where used. Popovers and menus land next to their triggers at any zoom.
- **Why**: User report (at 125% in an 800 px window the composer was below the fold).
- **Pinned by**: journeys/test_appearance.py :: zoomed_in_page_fills_the_window,
  zoomed_out_page_fills_the_window, zoomed_page_fills_a_narrow_window,
  tui_zoomed_in_page_fills_the_window, tui_zoomed_out_page_fills_the_window,
  popovers_land_next_to_their_triggers_zoomed_in, popovers_land_next_to_their_triggers_zoomed_out
  (the zoomed-out ones pass on the old code too); ui/features/members/MemberList.test.tsx (the sheet's
  height uses the token).
- **Not pinned**: modals, drawers and toasts at other zooms than the popover journeys' (CSS only).

---

## V. Privacy, message requests and sync with the phone

### V1. The phone's privacy settings are authoritative

- **Rule**: Read receipts, typing indicators and link previews (and "show read receipts") follow the
  phone's synced values, and changes made in Snowdrop go back through `updateConfiguration`. Nothing is
  sent before the first read on connect (receipts held, typing and previews wait). With read receipts
  off, others' read marks are hidden.
- **Why**: Signal Desktop parity.
- **Pinned by**: core/services/phonePrivacy.test.ts (all); core/stores/privacy.test.ts (all five);
  ui/features/settings/pages/PrivacyPage.test.tsx.

### V2. Reading in Snowdrop marks messages read on the phone

- **Rule**: Replying goes through the normal read path (earlier unread messages get a receipt or read
  sync, not just a local cursor). With receipts off or in a request, only a sync is sent. Receipt and
  sync outcomes are summarised and failures logged (types and counts only).
- **Why**: Bug report: the phone still showed the messages as unread.
- **Pinned by**: core/services/readSync.test.ts (all ten); core/services/ReadStateService.test.ts.

### V3. Message requests

- **Rule**: A DM is accepted for yourself, saved contacts or profile sharing; a group when someone
  known is in it; either when you accepted it, sent anything in it (here, from the phone, or in
  history) or it pre-existed the feature (grandfathered once). Until accepted: no read receipts or
  typing indicators, media waits behind Download, links are inert, and a request bar (Accept, Delete,
  Block; Unblock when blocked) replaces the composer. Accepting shares the profile and sends receipts
  for what was already read; it never un-accepts; delete keeps the chat from coming back unless a new
  message arrives.
- **Why**: Signal Desktop parity.
- **Pinned by**: core/domain/messageRequests.test.ts (all); core/services/messageRequests.test.ts
  (all); ui/features/chat/message/messageRequestMedia.test.tsx.

### V4. Block and unblock

- **Rule**: Available from the conversation, header, member and profile menus with Desktop's
  confirmations. Blocking a group also leaves it, keeping history (not when you are the only admin:
  choose a successor first). A blocked chat's composer shows a notice; Settings > Privacy lists the
  blocked with an Unblock that asks first; blocking syncs to the phone. A message from a blocked
  contact, or in a blocked group, never arrives: signal-cli drops it before storing or reporting it
  (`IncomingMessageHandler.isMessageBlocked`, in every configuration), and the demo backend does the
  same, so the app has nothing of its own to drop.
- **Why**: Signal Desktop parity.
- **Pinned by**: ui/features/conversation/blocking.test.tsx (all seven); ui/features/settings/pages/
  BlockedList.test.tsx (all four); core/services/messageRequests.test.ts (block cases);
  core/backend/mock/MockBackend.test.ts :: drops a message from a blocked contact or in a blocked
  group.

### V5. Phone-side answers and verifications apply here

- **Rule**: Message-request answers made on the phone (accept or unblock, block, delete,
  block-and-delete, "Reported as spam") apply here without sending anything, with the same timeline
  lines as a local answer; replays (even after a restart) never duplicate a line or undo a newer
  answer. A safety number marked verified on the phone writes "You marked your Safety Number with
  {name} as verified from another device" and never verifies over an untrusted key.
- **Why**: User request: phone-side answers kept being ignored.
- **Pinned by**: core/services/syncedAnswers.test.ts (all).
- **Not pinned**: the signal-cli side (patches 0023, 0024, 0026); the Java suites run via
  `scripts/build-signal-cli.sh --test`, not Vitest.

### V6. Timeline lines

- **Rule**: "You pinned a message", "{name} pinned a message", "{name} changed their profile name to
  {new}" (only for a known contact whose name really changed; a name first learned writes nothing),
  "You accepted the message request", "You blocked this person", "Secure session reset". Each has a
  stable id so replays never duplicate; none notifies or counts as unread.
- **Why**: Signal Desktop parity.
- **Pinned by**: core/services/timelineLines.test.ts (all 18); core/domain/misc.test.ts ::
  round-trips a system message id through parseMessageId.

### V7. Safety numbers

- **Rule**: View a contact's number (QR and 60 digits); mark or clear verified, with a badge and
  lines. A changed key shows "Safety Number with X has changed" with View Safety Number; a send
  stopped by one opens Safety Number Changes (review, or Send anyway approves the new key and
  retries); it never verifies over an untrusted key. The dialog opens by itself only when that chat
  is still open and the user has pressed no key or pointer button since they sent (or retried) the
  message: it would take focus from what they are doing. Otherwise the failed message's own "Failed
  to send" line, with Review safety number and Retry, is the way in. The viewer's "Not approved yet"
  and its hint follow the live trust state, so they go once the number is marked verified, and the
  Mark as verified button keeps focus while it works.
- **Why**: Signal Desktop parity; bug: the dialog opened asynchronously and took focus mid-typing.
- **Pinned by**: ui/features/safety/safety.test.tsx (all); ui/features/chat/message/
  MessageNotes.safety.test.tsx; app/userInput.test.ts; app/createSnowdrop.test.ts :: a send refused
  over a changed safety number (all three); journeys/test_dialogs.py ::
  a_failed_send_opens_the_safety_number_dialog_when_the_user_is_idle,
  a_failed_send_does_not_take_focus_from_typing,
  verified_safety_number_stops_saying_it_is_not_approved; ui/features/safety/safety.test.tsx ::
  stops saying the key is not approved once it is marked verified; ui/features/chat/list/SystemRow.test.tsx :: shows View Safety Number;
  src-tauri/src/rpc_guard.rs :: list_identities_takes_exactly_one_person;
  trust_takes_one_person_and_one_selector.

### V8. Recycled numbers

- **Rule**: A number that moves to a different account moves with it; two accounts are never merged. A
  chat keyed by the old number sends to its previous holder, or refuses when none is known; forked DMs
  fold into one writable conversation (the more recently active id).
- **Why**: Data safety: never send to the wrong person.
- **Pinned by**: core/backend/signal-cli/peers.test.ts (all eight); core/backend/signal-cli/
  SignalCliBackend.test.ts :: never sends from a chat keyed by a recycled number to the number’s new
  owner; refuses to send from a moved-number chat whose holder is unknown.

### V9. Early operations are held for 24 hours

- **Rule**: Reactions, edits, deletes and poll votes for messages not stored yet are held for 24 hours
  (capped overall and per author) and applied when history paging or import brings the message in; a
  failed store puts them back.
- **Why**: Bug: deletes and reactions were lost on import.
- **Pinned by**: core/services/PendingOpsBuffer.test.ts (all); core/services/services.test.ts ::
  applies a delete and a reaction held for a message that backfill brings in much later; keeps held
  operations when the page they were applied to fails to store; core/services/historyImport.test.ts ::
  applies a delete held for a message the import brings in.

### V10. Profile editing

- **Rule**: Settings > Profile edits first and last name, about (with emoji) and photo within Signal's
  limits (name 26 characters or 128 bytes, about 140 or 512, centre square, at most 512 px JPEG). It
  saves through `updateProfile` and refreshes at once; a local edit survives a stale storage sync
  until uploaded.
- **Why**: User request.
- **Pinned by**: ui/features/settings/pages/ProfilePage.test.tsx (all); ui/features/settings/lib/
  profileFields.test.ts (all); core/services/profile.test.ts (all five).
- **Not pinned**: the signal-cli merge rule (patch 0026) that keeps a local edit over a stale record;
  it needs the Java suite.

### V11. New chat by contact, number or username

- **Rule**: Ctrl/Cmd+N opens a dialog with Desktop's not-found, rate-limit and country-code messages.
  Nothing is sent until the first message; the new DM uses the id incoming messages will resolve to,
  so it never forks.
- **Why**: Signal Desktop parity.
- **Pinned by**: ui/features/newChat/NewMessageDialog.test.tsx (all); ui/features/newChat/
  model.test.ts; core/domain/recipient.test.ts.

### V12. Group management

- **Rule**: Edit name, description and photo; add and remove members; admins, join requests, invite
  links, permissions and announcement groups (a notice instead of the composer); leave (choose a
  successor if last admin; a left group stays read-only with history). Everything is gated by role
  and group permissions; "You added…" lines. A group name is at most 32 characters and 1024 bytes
  (a description 480 and 8192): the byte cap keeps one character, a ZWJ sequence that can be
  extended without end, from growing without limit when typed a code unit at a time. A group
  dialog open when its action stops being possible closes (M15).
- **Why**: Signal Desktop parity.
- **Pinned by**: ui/features/groups/groups.test.tsx (all); test/groupService.test.ts (all);
  core/domain/groups.test.ts (all six).

### V13. Sign-out and erase

- **Rule**: Sign-out keeps its dialog up through the whole flow; failures restore the connection and
  show the error. It clears the account's local data (notes, pins, drafts, requests, peers, cursors,
  recent stickers, custom emoji, backfill markers, log files) but keeps settings, themes and spaces;
  history is cleared only after the vault sign-out succeeds (a flag is set for the next boot
  otherwise). It reminds you to remove the linked device on the phone. Erase requires typing ERASE.
- **Why**: User request; security audit.
- **Pinned by**: ui/features/settings/pages/signOutFlow.test.ts (all); ui/features/settings/pages/
  SignOutDialog.test.tsx (all three); app/App.test.tsx :: keeps the sign-out dialog up while the flow
  runs; app/createSnowdrop.signalCli.test.ts :: sign-out clears the account’s local data and keeps
  settings, spaces and other accounts; app/dataScope.test.ts; ui/features/settings/pages/
  EncryptionSection.test.tsx (erase cases).

### V14. The recovery key is never lost

- **Rule**: The recovery-key reveal stays open until you confirm you saved it (Esc and an outside click
  don't dismiss it) and says why. The last unlock method cannot be removed. Passphrase fields clear
  after saving. One passphrase rule (8 or more characters, space-only allowed) applies to setup and
  settings.
- **Why**: User bug: the key could be lost.
- **Pinned by**: ui/features/settings/pages/EncryptionSection.test.tsx :: keeps the new key on screen
  through Escape and outside clicks, and says why; disables removing the recovery key when it is the
  only unlock method; ui/features/onboarding/StorageSetup.test.tsx; ui/features/onboarding/
  UnlockScreen.test.tsx :: lets a passphrase made of spaces be submitted, as setup allows one.

### V15. Export history

- **Rule**: Export warns that the file is readable by anyone and not a restore point, and defaults to
  an encrypted export on desktop (Argon2id and XChaCha20-Poly1305); plain export is behind the
  warning. Disappearing messages are left out. It is not called a backup.
- **Why**: Security audit.
- **Pinned by**: ui/features/settings/pages/DataPage.test.tsx (export cases); core/services/
  historyExport.test.ts; src-tauri/src/export_crypto.rs (unit tests).

### V16. Local storage is encrypted

- **Rule**: Every encrypted `localStorage` key name is HMAC-blinded; outbox attachment rows keep no
  plaintext name or type; side indexes (pins, timers, gallery kinds) are encrypted.
- **Why**: Security audit.
- **Pinned by**: app/persistence.test.ts; core/persistence/* (the test files there);
  src-tauri/src/keyslots.rs, storage.rs and vault/*.rs.

### V17. Bidi controls are stripped

- **Rule**: Names, titles and filenames have bidi controls stripped at normalisation and render with
  `unicode-bidi: isolate`; message bodies use `dir="auto"`.
- **Why**: Security audit.
- **Pinned by**: core/lib/lib.test.ts :: removes bidi override, embedding and isolate controls; can
  neutralise a spoofed filename extension; ui/features/chat/message/MessageBody.test.tsx :: sets
  dir="auto" so RTL text renders in its own direction.

### V18. Contacts and groups after linking

- **Rule**: Groups are re-listed after the phone's sync lands and at 5, 20 and 60 s and 3 minutes
  after connecting. Settings > Connection has "Sync contacts and groups"; conversations note that
  history from before linking isn't available; history attachments offer "Get from phone"; imported
  history never resurrects deleted requests or ended polls.
- **Why**: User bug: the chat list was empty after linking.
- **Pinned by**: core/backend/signal-cli/SignalCliBackend.test.ts :: re-lists groups too; keeps
  checking while there are no groups yet, so a late sync still lands; ui/features/settings/pages/
  ConnectionPage.test.tsx :: calls sendSyncRequest, then re-lists; ui/features/chat/list/
  ConversationIntro.test.tsx (both).

---

## H. Desktop shell, startup, storage

### H1. Linux AppImage UI freezes

- **Rule**: The AppImage does not bundle the GL/EGL loaders (a 4 to 5 s first paint of Settings on
  Intel and Hyprland), uses a Snowdrop-owned GStreamer registry warmed at startup, and points
  GStreamer at the bundled plugin scanner.
- **Why**: User report: a 5 s Settings freeze.
- **Pinned by**: src-tauri/src/appimage.rs (scanner override, registry path, a user-configured
  registry is left alone).
- **Not pinned**: the excluded libraries in the build config and the first-paint timing; a journey
  against the packaged app would pin them.

### H2. Window state is not restored

- **Rule**: Snowdrop does not restore the saved window state. (`tauri-plugin-window-state` was removed
  because a tiling compositor's "maximized" flag made the window come back covering other tiles.)
- **Why**: User bug report on a tiling compositor.
- **Pinned by**: platform/tauri/windowState.test.ts (both: no window-state plugin in `Cargo.toml`,
  `package.json`, the capabilities or `tauri.conf.json`, and none registered in the Rust sources).
- **Not pinned**: nothing.

### H3. signal-cli is installed outside the vault's legacy folder

- **Rule**: signal-cli is installed under `<app data>/bin/signal-cli/<version>/`, never the folder the
  vault treats as legacy plaintext. Legacy migration needs a `data/` directory and never runs over a
  vault that already has a manifest; vault sync touches only `data/`, `attachments/`, `avatars/` and
  `stickers/`.
- **Why**: Critical user bug: the linked account was wiped on every launch.
- **Pinned by**: src-tauri/src/storage.rs :: legacy_detection_requires_a_data_subdirectory;
  migration_is_skipped_when_the_vault_already_has_a_manifest; sign_out_keeps_the_installed_signal_cli_binary;
  src-tauri/src/vault/sync.rs :: walk_skips_entries_outside_the_allowlisted_top_dirs.
- **Not pinned**: the account surviving a launch end to end (the vault end-to-end test is ignored
  unless `SNOWDROP_E2E_SIGNAL_CLI` is set).

### H4. The vault never deletes unviewed media

- **Rule**: Media is restored lazily; a sync drops only media the session materialised and which then
  went missing. A WAL-mode database with a non-empty WAL is copied even though its `.db` did not
  change; media loads never wait on a sync.
- **Why**: User bug: every unviewed image was deleted after the first sync.
- **Pinned by**: src-tauri/src/vault/session.rs :: fresh_start_sync_does_not_delete_unhydrated_media;
  evicted_media_survives_a_subsequent_sync; sync_drops_media_actually_deleted_after_being_materialized;
  a_wal_only_change_is_synced_and_an_idle_wal_is_not_recopied;
  hydration_during_the_first_ever_sync_waits_instead_of_failing; src-tauri/src/vault/sync.rs ::
  syncs_a_wal_mode_database_with_an_open_writer.

### H5. Java signal-cli by default; native is opt-in

- **Rule**: The Java build runs by default. The native build is used only with
  `SNOWDROP_SIGNAL_CLI_NATIVE=1` (it hung on `getHistoryDirectory` with a real account);
  `SNOWDROP_SIGNAL_CLI_JVM=1` forces Java; Settings > Connection says which build runs; a native
  failure is remembered for that build.
- **Why**: User decision: native is shelved and opt-in.
- **Pinned by**: src-tauri/src/native_build.rs :: nothing_installed_or_not_asked_for_means_no_native_build;
  a_failure_is_remembered_for_that_build_only; src-tauri/src/config.rs ::
  resolves_configured_then_native_then_patched_then_downloaded_then_bundled_then_path.

### H6. signal-cli starts in parallel with the window

- **Rule**: The shell remembers the last spawn-mode connect (never an account number) and starts
  signal-cli as soon as storage is open (a silent keyring unlock right after setup). The frontend's
  connect reuses the child; it is skipped for external daemons, no linked account or locked storage;
  erase and sign-out clear the record.
- **Why**: User request (startup speed).
- **Pinned by**: src-tauri/src/startup.rs (unit tests).
- **Not pinned**: the startup-time benefit; a timed startup test would pin it.

### H7. Quitting and relaunching

- **Rule**: A new instance waits at most 10 s for the previous instance's teardown. Quitting does not
  wait on unanswered requests. The close handshake flushes the last encrypted write (3 s fallback).
- **Why**: Data safety.
- **Pinned by**: platform/tauri/closeHandshake.test.ts (all four); app/DesktopBootedApp.dispose.test.tsx
  (all four); app/DesktopBootedApp.test.tsx.
- **Not pinned**: the 10 s single-instance wait; a Rust test of the wait loop would pin it.

### H8. Microphone and paste are gated by gestures

- **Rule**: The shell grants the microphone only right after a real click or key press and denies
  every other webview permission; reading files from the clipboard needs a native paste gesture;
  WebKit DNS prefetching is off.
- **Why**: Security audit.
- **Pinned by**: src-tauri/src/mic_gate.rs; src-tauri/src/paste_gate.rs; src-tauri/src/
  webview_privacy.rs; app/indexHtml.test.ts :: turns DNS prefetching off, so visible link hosts are
  never resolved ahead of a click.

### H9. The signal-cli RPC is allow-listed in Rust

- **Rule**: Only the methods the UI calls are allowed; account-destroying and config methods are
  rejected; params that signal-cli would read as host file paths are rejected in every spelling;
  `updateConfiguration`, `updateProfile`, `getAvatar`, `trust` and `listIdentities` are restricted to
  their documented fields. The allow-list never keeps a method nothing calls.
- **Why**: Security audit.
- **Pinned by**: src-tauri/src/rpc_guard.rs (unit tests); src-tauri/src/commands.rs ::
  allows_every_method_the_ui_actually_calls; rejects_account_destroying_and_config_methods.

### H10. Cancel on quit or unmount

- **Rule**: Long calls take a caller signal. Aborted before dispatch means not sent; after dispatch
  (for a mutating call) means maybe sent. A Rust-side cancel ends the wait with "aborted" and never
  triggers the hang fallback.
- **Why**: Robustness; feeds M4.
- **Pinned by**: src-tauri/src/cancel.rs; platform/tauri/TauriTransport.test.ts (abort cases);
  core/lib/abort.test.ts; app/deferredBackend.test.ts.

### H11. Retry reconnects; the user is never sent to the link screen

- **Rule**: A remembered account that fails to load restarts signal-cli with backoff (2, 5, 15, 30 s),
  then reconnects every minute; the user is never routed to the link screen.
- **The banner's copy promises only what happens**: nothing resends by itself when the connection
  returns, so the offline line says a message that fails to send can be retried once it is back
  (never that it "will go out").
- **Why**: User bug: the link screen showed after a network blip.
- **Pinned by**: ui/features/chat/ConnectionBanner.test.tsx :: offline copy promises only what
  happens: a failed message can be retried; core/services/services.test.ts :: retries account-unavailable automatically every
  60s, never routing to the link screen; a failed reconnect reports the error, and the next Retry
  tries again; platform/tauri/TauriTransport.test.ts :: retries a subscription while signal-cli is
  restarting, and gives up when it is missing; src-tauri/src/process.rs ::
  backs_off_exponentially_up_to_a_cap.

### H12. Logging

- **Rule**: One redacted log (phone numbers, UUIDs, `sgnl://` URIs, long base64 and the home directory
  masked; control and bidi characters stripped; capped; mode 0600; one 1 MiB rotation). Expected setup
  states log once at info; erase and sign-out remove logs.
- **Why**: Privacy; user request.
- **Pinned by**: src-tauri/src/redact.rs; src-tauri/src/applog.rs; app/createSnowdrop.signalCli.test.ts
  :: logs "no account yet" once, at info, not three times; core/services/services.test.ts :: logs an
  expected setup state once, at info, instead of as an error.

### H13. Data directories are 0700

- **Rule**: Data directories are mode 0700 and `signal-cli.log` 0600 (existing installs are fixed too).
- **Why**: Security audit.
- **Pinned by**: src-tauri/src/config.rs :: secure_dir_locks_a_directory_to_its_owner;
  secure_dir_fixes_a_directory_left_over_from_an_earlier_install.

### H14. Links open in the system browser

- **Rule**: Only web and mail links open, in the system browser; the app navigates nowhere.
- **Why**: Security audit.
- **Pinned by**: src-tauri/src/commands.rs :: opens_only_web_and_mail_links; platform/tauri/
  TauriTransport.test.ts :: opens web links in the system browser instead of navigating.

### H15. Linux notifications

- **Rule**: One notification per conversation, replaced in place and closed when stale; markup is
  escaped only where the server renders it; one D-Bus connection.
- **Why**: User request.
- **Pinned by**: src-tauri/src/notifications.rs (unit tests); platform/tauri/notifications.test.ts
  (all seven).

### H16. Storage gate and boot

- **Rule**: Boot retries ("Try again") on a failed boot or status query. Unlock offers "Check keyring
  again" when no recovery key or passphrase exists. An unreadable encrypted web cache is discarded when
  storage needs setup. Erase stops persistence only after `eraseAll` succeeds; a failed restart shows
  a retry, never the destructive button again; passphrase fields are cleared.
- **Why**: User bug reports: users were stranded.
- **Pinned by**: app/StorageGate.test.tsx (all nine); ui/features/onboarding/UnlockScreen.test.tsx,
  StorageSetup.test.tsx, StorageUnavailable.test.tsx and RestartRequiredScreen.test.tsx; ui/features/
  settings/pages/EncryptionSection.test.tsx (erase cases).

---

## G. signal-cli patches and their wire rules

Patch numbers have been squashed and renumbered over time; the numbers in code refer to the
`history.N` version string. The Java suites live inside the patches and run with
`scripts/build-signal-cli.sh --test`; they are not part of Vitest.

### G1. Ordered catching-up signal

- **Rule**: The patched signal-cli announces `catchingUp` on the receive thread for each new
  connection (after its first read, before any envelope) and `caughtUp` when the queue drains. The app
  treats build 21 or later as having the signal and 23 or later as ordered.
- **Why**: Bug report: notification flood after waking from sleep.
- **Pinned by**: core/backend/signal-cli/SignalCliBackend.test.ts :: reports the catching-up signal only
  on build 21 or later; reports the ordered catching-up signal only on build 23 or later; maps a
  receiveCatchingUp SSE event to the catchingUp backend event, in order; still emits catchingUp at
  once, ahead of a held queue; a caughtUp from an earlier catch-up does not end a newer one.

### G2. Reading in Snowdrop syncs to the phone

- **Rule**: Reading sends `sendReceipt --sync-only` (new builds); an older build never gets a
  sync-only call, because it would send a real receipt.
- **Why**: Bug: the phone showed the messages as unread.
- **Pinned by**: core/backend/signal-cli/SignalCliBackend.test.ts :: asks signal-cli for syncOnly on a
  build with patch 0019; never sends a sync-only read to an older build; core/services/
  readSync.test.ts :: receipts off: sync-only, and an old signal-cli sends nothing at all.

### G3. A linked device does not blank your username

- **Rule**: A linked device's account-record re-upload leaves the username and username link as the
  primary wrote them.
- **Why**: User bug: the phone said "problem with your username".
- **Not pinned**: Java patch suite only; a case in the patch's Java tests would pin it (there is no
  Vitest-level test).

### G4. Attachment backfill timing

- **Rule**: A failed attachment download can be fetched again. Pointers are stored before download;
  backfill requests stay pending up to 3 minutes in signal-cli, past the UI's 2-minute wait, so Retry
  resends.
- **Why**: Bug reports.
- **Pinned by**: ui/features/chat/message/useAttachmentUrl.test.tsx (see D1 and D2).
- **Not pinned**: the relationship between the 3-minute and 2-minute constants (two constants in two
  languages); a test comparing them would pin it.

### G5. Attachment memory limits

- **Rule**: `getAttachment` streams into the JSON-RPC output; the heap cap is
  `-XX:MaxRAMPercentage=50`, not a fixed 1 GiB; temp files live in `<config>/snowdrop-tmp` (0700),
  never `/tmp`; periodic G1 cycles return idle memory; `MALLOC_ARENA_MAX=2` on Linux unless set.
- **Why**: User bug: large attachments ran the daemon out of memory; idle memory use.
- **Pinned by**: src-tauri/src/config.rs :: spawn_env_caps_malloc_arenas_on_linux_when_unset;
  spawn_env_never_overrides_an_existing_malloc_arena_max; spawn_env_is_a_no_op_off_linux.
- **Not pinned**: the heap flags and streaming; the Java suite or a launch-flag test would pin them.

### G6. Stickers load on a real account

- **Rule**: `retrieveSticker` re-reads after a pack download (bounded retries without the patch);
  `installKnownStickerPack` installs by id and the key never crosses RPC; history stickers register
  uninstalled and unsynced.
- **Why**: Bug reports.
- **Pinned by**: core/backend/signal-cli/SignalCliBackend.test.ts :: retries once for a live sticker;
  registers a history sticker pack, then gives a pre-0016 daemon its second call; stays bounded and
  reports the first failure when the sticker never resolves; lists installed packs, drops the key,
  and leaves out uninstalled ones.

### G7. Custom emoji delivery

- **Rule**: Field 9000 is carried to the JSON-RPC envelope and its attachments are downloaded; the
  deferred backend forwards the emoji.
- **Why**: Bug report: custom emoji were never delivered (a missing forwarder).
- **Pinned by**: app/deferredBackend.test.ts :: passes every argument of every member through
  unchanged, and returns the result; exposes every ChatBackend member; core/backend/signal-cli/
  params.test.ts :: adds customEmoji as {name, attachment} pairs.
- **Not pinned**: the serialised-JSON behaviour lives in the Java patch suite.

### G8. Profile edit updates the storage-service record

- **Rule**: A profile edit updates the storage-service account record, and a stale remote record does
  not put the old name or photo back until the upload lands.
- **Why**: User bug.
- **Not pinned**: Java patch suite only; a Java test of the merge would pin it.

### G9. Phone-side answers reach Snowdrop

- **Rule**: Phone-side message-request answers and verifications reach Snowdrop; spam and
  block-and-spam are decoded; a group block applies locally only.
- **Why**: User request.
- **Pinned by**: core/services/syncedAnswers.test.ts (the TypeScript side).
- **Not pinned**: decoding in the Java patch suites.

---

## R. Data integrity and robustness

### R1. Never delete data on a wrong key or unreadable row

- **Rule**: Unreadable stored messages don't block writes; unreadable outbox entries are skipped and
  kept; one outbox entry failing to restore doesn't stop the others. A send acknowledged but not
  stored retries the commit, then shows as sent under its real id and is never resent. A stored
  version of any saved data (settings, local state) that is not a whole number from 0 (-1e300, 1.5) is
  corrupt: a backup is kept and defaults are used, and the migration never loops on it.
- **Why**: Data safety.
- **Pinned by**: core/services/services.test.ts :: one outbox entry failing to restore does not stop
  the others; retries the commit, so a transient failure leaves a normal sent message; is shown as
  sent, never offered for resend, and is completed on the next start; is completed after a restart
  even when the repository could not take the sent state; core/persistence/keyValue.test.ts ::
  treats a stored version that is not a whole number from 0 as corrupt; treats a stored version far
  below zero as corrupt; core/persistence/* tests.

### R2. Deleting a conversation

- **Rule**: Deleting a conversation removes queued sends and abandons in-flight ones; remotely deleted
  messages drop previews, custom emoji and failed recipients.
- **Why**: Data safety.
- **Pinned by**: core/services/services.test.ts :: does not recreate a message in a conversation
  deleted while its send was in flight; core/domain/misc.test.ts :: a remote delete leaves no link
  preview, custom emoji or failed-recipient residue.

### R3. A failed delete for everyone restores the content

- **Rule**: A failed delete for everyone restores the content without resurrecting a reaction removed
  meanwhile.
- **Why**: Bug.
- **Pinned by**: core/services/services.test.ts :: a failed delete for everyone brings the content back
  and keeps what changed meanwhile; a failed delete does not bring back a reaction someone took back
  meanwhile.

### R4. Per-account local state

- **Rule**: Spaces, pins, notes and drafts persist per scope (`demo` or `signal-cli:<account>`);
  rebinding on account discovery merges anything done meanwhile; legacy keys migrate once; switching
  account or daemon clears cached history first.
- **Why**: Bug: demo data appeared in a real account.
- **Pinned by**: app/dataScope.test.ts (all); app/createSnowdrop.signalCli.test.ts (rebind cases);
  ui/features/settings/pages/ConnectionPage.test.tsx :: clears this computer’s cached history before
  reloading, with a note in the confirm dialog.

### R5. Reload waits for encrypted settings writes

- **Rule**: A reload after switching backend, naming an account or a reset waits for encrypted settings
  writes to finish.
- **Why**: Bug: the change that needed the reload was lost.
- **Pinned by**: app/createSnowdrop.test.ts :: waits for an asynchronously persisting store before
  reloading.

### R6. Event order

- **Rule**: Incoming events apply in order through two queues; read receipts go out in their own
  ordered chain; the initial sync waits at most 5 s for the contact refresh, and messages arriving
  meanwhile are applied after; `caughtUp` is stamped with its catch-up and queued behind earlier
  messages.
- **Why**: Bug: unread counts and previews were wrong after catch-up.
- **Pinned by**: core/services/eventPipeline.test.ts (all); core/services/checkpoint.test.ts (all
  four); app/createSnowdrop.faulty.test.ts :: keeps connecting while listContacts is slow, parking live
  messages and applying them once ready.

### R7. Confirm dialogs

- **Rule**: Confirm-and-run dialogs show busy, can't be dismissed while working, show a refusal inline,
  close once done, and focus Cancel for danger actions.
- **Why**: Consistency.
- **Pinned by**: ui/primitives/ConfirmDialog.test.tsx (all three).

### R8. Resource budgets

- **Rule**: History keeps at most 8 conversations' windows in memory; avatars and attachments stay
  within their budgets; typing no longer triggers a vault sync.
- **Why**: Performance.
- **Pinned by**: core/services/services.test.ts :: closes the least-recently-opened conversation past
  the cap.
- **Not pinned**: the avatar and attachment budgets as shipped (D6, D8) and "typing never triggers a
  vault sync"; a Rust test counting syncs per typing event would pin the second.

### R9. Typing indicators

- **Rule**: Typing is throttled and expires after a TTL; it is cleared when the author's message lands;
  it is shown by first name, never yourself; not sent to a request or before the first privacy read.
- **Why**: Signal parity.
- **Pinned by**: core/stores/typing.test.ts (all five); core/services/services.test.ts :: throttles
  typing and honours the setting and guards; expires typing indicators and clears them when the
  author’s message lands; ui/features/chat/lib/lib.test.ts :: describes one, two and several typers by
  first name, never yourself.

---

## Shared logic

Places where two rules share logic that could drift apart. Each is covered by tests, but not by one
test across the implementations.

1. **Sidebar freeze and notification hold** (resolved): one tracker in `SyncService` now drives
   `session.catchingUp` and `session.notificationsHeld`, so they cannot end at different times
   (S2, N2). `historyImport` still reads `session.catchingUp` alone, which is now the same flag.
2. **"Is the user looking at this chat"** is written twice: `SyncService.isViewing` (auto-read) and
   `NotificationService` (suppress a notification). Both read window focus, the selected
   conversation and `scrolledUp`, which the list publishes using the half-page follow slack (C1).
   `useReadTracking` (C7) is a third expression (focus plus intersection).
3. **Follow slack**: `slackFor()` in `bottomPin.ts` is shared by the pin and Virtuoso's at-bottom
   threshold, but the jump pill (`useArrivalsBelow`), `scrolledUp`, read tracking and follow-own-send
   each consult "at bottom" separately. A test driving all of them from one scroll position would
   catch drift.
4. **Attention rule**: `attentionOf` (dots, collapsed sections, switcher space dot, mark-all-read),
   the `core/stores/views.ts` counts (badge, rail, tray), the sidebar model's collapsed visibility
   and keyboard walking. The tests compare them pairwise.
5. **Message actions**: `MESSAGE_ACTIONS` covers key, command, menu and hover bar, but some
   differences are intentional (Shift-delete, command-path edit re-check, Discard for failed
   sends). `SendService` re-checks the edit and delete windows after the UI gate.
6. **Edit and delete limits**: the window constants live in `domain/editing.ts`, but the 48 h
   incoming-edit drop is in `SyncService` and the delete window in `SendService` and
   `messageActions`.
7. **Message wording**: one `messageSummary` feeds notifications and the live announcer, but the
   sidebar preview goes through `ui/features/conversation/preview.ts` with its own author prefix,
   "You" and poll marker. Spoiler masking is tested in each place; the wording is not compared.
8. **What a link is**: `ui/features/chat/lib/links.ts` (bare domains link), the composer's preview
   extraction (explicit http(s) only) and `link_preview.rs` (https only).
9. **Backfill timing across languages**: the UI waits about 2 minutes (`useAttachmentUrl`,
   `forward/media.ts`) while signal-cli keeps a request pending 3 minutes (patch); the "three
   outstanding" limit in `backfillGate` and the three concurrent avatar calls are separate
   constants.
10. **Close-to-tray default**: the TypeScript setting defaults to on, the Rust side to off until the
    frontend mirrors it (T10).
11. **Build thresholds**: `capabilities.ts` gates `catchingUpSignal` on build 21, `orderedCatchingUp`
    on build 23 and `deleteSync` on build 27; the numbers are the `history.N` version, so a re-squash
    that changes it changes the gating.
12. **Focus-on-open policy**: `focusTargets`, the Vim plugin's policy, the `focusComposerOnOpen`
    setting and each opener calling `openConversation`. A new opener that bypasses it skips the
    policy; no lint or test enumerates the openers.
13. **Phone-following settings**: `stores/privacy.ts`, `PhonePrivacyService`, `usePhoneSetting`,
    `PrivacyPage`, `BehaviourPage` and `ComposerLinkPreview` each handle "phone value not yet read".

## Conflicts checked

- **N8 and the in-app click test**: not a conflict. N8 is about the desktop adapter
  (`platform/tauri/notifications.ts`), which cannot report clicks and ignores `onClick`; the click
  to open a conversation was added and then reverted as not requested. The test
  `NotificationService.test.ts :: clicking focuses the window and opens the conversation in its
space` exercises the service's `onClick` hook, which the browser `Notification` adapter wires
  (`n.onclick`). If a future desktop adapter wires clicks, N8 and its docs must change together.
- **T10 close to tray**: the Rust default is off until `createSnowdrop` mirrors the TypeScript
  default (on) through `app_set_close_to_tray`; a close before that mirror quits instead of hiding.
- **N2 test title**: `the sidebar catch-up flag alone does not hold notifications (its ceiling is
shorter)` still passes but describes the old two-tracker design; the title should be updated.

## Not pinned yet

No test at all: G3, G8 (Java patch suite only; a Java test in the patch would pin each).

Pinned, but with a part that is not: S2, S5, S13, S18, S19, S22, C2, C4, C5, C6, C7, C8, C10, C12,
C13, C19, C25, M8, M9, M13, M15, M18, P6, P10, P13, N1, N4, D8, D9, T1, T4, T5, T6,
T10, T11, T14, T16, V5, V10, H1, H3, H6, H7, G4, G5, G7, G9, R8.

## Next journeys

Behaviour that needs real layout, focus, timing or input. Not covered by any journey yet: C2 (not
reproducible in the runner, see its entry) and H1 (needs the packaged AppImage). Covered
in part, worth extending: S18 (only Down after a click), C5 (a composer growing under a reader who
is scrolled up), C6 (newer pages after a jump), M15 (drawers).
