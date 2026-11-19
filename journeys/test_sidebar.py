import json

from common import (
    COMPOSER,
    IN_COMPOSER,
    MESSAGE,
    ON_LIST,
    ON_SIDEBAR_ROW,
    PREVIEW,
    click_menu_item,
    click_text_starting,
    emit,
    open_conversation,
    open_menu,
    quiet,
    select_space,
    send,
    settle,
)
from harness import journey

SELECTED_PREVIEW = PREVIEW.replace('[data-snowdrop=conversation-row]', '[data-snowdrop=conversation-row][data-selected]')


@journey()
def sidebar_preview_follows_an_edit(page):
    """Send a message, edit it (Up in the empty composer): the message and the chat's sidebar preview both show the edit."""
    open_conversation(page, 'dm-priya')
    send(page, 'a first draft')
    page.wait_for(f'document.querySelector({SELECTED_PREVIEW!r})?.textContent.includes("a first draft")')
    page.click(COMPOSER)
    page.key('ArrowUp')
    page.wait_for('!!document.querySelector("[data-snowdrop=message] textarea")')
    page.type(' with an edit')
    page.key('Enter')
    page.wait_for(
        f'(() => {{ const m = [...document.querySelectorAll({MESSAGE!r})]; return m[m.length - 1].textContent.includes("an edit"); }})()'
    )
    page.wait_for(f'document.querySelector({SELECTED_PREVIEW!r})?.textContent.includes("an edit")', 3000)


@journey()
def sidebar_preview_follows_a_delete_for_everyone(page):
    """Send a message, delete it for everyone from the keyboard: the message turns into 'You deleted this message' and the sidebar preview into 'Message deleted'."""
    open_conversation(page, 'dm-priya')
    send(page, 'to be deleted')
    page.wait_for(f'document.querySelector({SELECTED_PREVIEW!r})?.textContent.includes("to be deleted")')
    page.key('Escape')
    page.wait_for('document.activeElement?.matches("[data-snowdrop=message]")')
    page.key('Delete')
    page.wait_for('!!document.querySelector("[role=alertdialog], [role=dialog]")')
    page.key('Enter')
    page.wait_for(
        f'(() => {{ const m = [...document.querySelectorAll({MESSAGE!r})]; return m[m.length - 1].textContent.includes("You deleted this message"); }})()'
    )
    page.wait_for(f'document.querySelector({SELECTED_PREVIEW!r})?.textContent.includes("Message deleted")', 3000)


ROWS = '[data-snowdrop=sidebar] [data-conversation-id][data-roving-item]'


@journey()
def arrow_keys_step_from_the_clicked_row(page):
    """After clicking a conversation row, focus is on it and Down moves to the row below it, not to the first row."""
    rows = page.eval(f'[...document.querySelectorAll({ROWS!r})].map((e) => e.getAttribute("data-conversation-id"))')
    clicked = rows[3]
    page.click(f'[data-conversation-id="{clicked}"]')
    page.wait_for(f'__journey.state().selected === {clicked!r}')
    page.wait_for(f'document.activeElement === document.querySelector(\'[data-conversation-id="{clicked}"]\')')
    page.expect_stays(f'document.activeElement === document.querySelector(\'[data-conversation-id="{clicked}"]\')', 500)
    page.key('ArrowDown')
    page.wait_for(f'document.activeElement === document.querySelector(\'[data-conversation-id="{rows[4]}"]\')')


@journey()
def archive_list_alt_arrows_stay_on_the_rows_shown(page):
    """Archived chats open with its one chat open: Alt+Down and Alt+Up have no other row to step to there, so the chat stays open (S18, the keys walk the rendered rows and clamp)."""
    click_text_starting(page, '[data-snowdrop=sidebar] button', 'Archived chats')
    page.wait_for(f'document.querySelectorAll({ROWS!r}).length === 1')
    archived = page.eval(f'document.querySelector({ROWS!r}).getAttribute("data-conversation-id")')
    page.click(f'[data-conversation-id="{archived}"]')
    page.wait_for(f'__journey.state().selected === {archived!r}')
    page.wait_for(f'!!document.querySelector({COMPOSER!r})')
    page.click(COMPOSER)
    page.key('ArrowDown', ['alt'])
    settle(page, 700)
    page.expect(f'__journey.state().selected === {archived!r}', 'Alt+Down opened a chat the Archived list does not show')
    page.key('ArrowUp', ['alt'])
    settle(page, 700)
    page.expect(f'__journey.state().selected === {archived!r}', 'Alt+Up opened a chat the Archived list does not show')


HAMBURGER = '[data-snowdrop=chat-header] button[aria-label^="Open navigation"]'
DRAWER = '!!document.querySelector("[data-snowdrop=drawer]")'


@journey()
def navigation_drawer_does_not_come_back_on_narrowing(page):
    """Narrow window, drawer opened, window widened (the drawer is gone), a chat is being used, window narrowed again: the drawer stays closed, because a conversation is open (S20, "open until a conversation is picked")."""
    open_conversation(page, 'dm-priya')
    page.resize(700, 800)
    page.click(HAMBURGER)
    page.wait_for(DRAWER)
    page.resize(1280, 800)
    page.wait_for(f'!({DRAWER})')
    page.click(COMPOSER)
    page.resize(700, 800)
    settle(page, 600)
    page.expect(f'!({DRAWER})', 'the navigation drawer opened over the open chat')
    page.expect(f'document.activeElement === document.querySelector({COMPOSER!r})', 'the composer lost focus to the drawer')


@journey(
)
def search_text_survives_narrowing_below_1100(page):
    """Conversation search open with a query, the window narrowed to 1099 px (the panel becomes a sheet): the query is still in the field."""
    open_conversation(page, 'dm-priya')
    page.key('f', ['ctrl'])
    page.wait_for('!!document.querySelector("[data-snowdrop=search-panel] input")')
    page.type('lunch')
    page.resize(1099, 800)
    settle(page, 700)
    page.expect('document.querySelector("[data-snowdrop=search-panel] input")?.value === "lunch"', 'the search text was lost')


@journey()
def search_text_survives_narrowing_below_760(page):
    """Conversation search open with a query, the window narrowed to 700 px (the navigation becomes a drawer, the panel a sheet) and widened again: the query is still in the field each time."""
    open_conversation(page, 'dm-priya')
    page.key('f', ['ctrl'])
    page.wait_for('!!document.querySelector("[data-snowdrop=search-panel] input")')
    page.type('lunch')
    for width in (700, 1280):
        page.resize(width, 800)
        settle(page, 700)
        page.expect('document.querySelector("[data-snowdrop=search-panel] input")?.value === "lunch"', f'the search text was lost at {width} px')


# ------------------------------------------------------------------ a focused row that leaves hands focus on (M15)

NOT_BODY = 'document.activeElement !== document.body'


def row_button(conversation):
    return f'[data-snowdrop=sidebar] [data-conversation-id="{conversation}"]'


def archive_row(page, conversation):
    """The hover Archive button of a sidebar row, pressed with the pointer (it takes focus, as a click does)."""
    page.hover(row_button(conversation))
    archive = f'[data-snowdrop=sidebar] [data-row-id="{conversation}"] button[aria-label="Archive"]'
    page.wait_for(f'!!document.querySelector({archive!r})')
    page.click(archive)
    page.wait_for(f'!document.querySelector({row_button(conversation)!r})')


@journey()
def archived_focused_row_hands_focus_to_the_next_row_else_the_previous(page):
    """Focus is on a sidebar row's Archive button and the chat is archived: focus goes to the next row in the list; archiving the last row's chat puts it on the one before; never the page (M15, a focused row that disappears)."""
    rows = page.eval(f'[...document.querySelectorAll({ROWS!r})].map((e) => e.getAttribute("data-conversation-id"))')
    middle = rows[2]
    archive_row(page, middle)
    settle(page, 300)
    page.expect(f'document.activeElement === document.querySelector({row_button(rows[3])!r})', 'focus did not go to the next row')
    shown = page.eval('[...document.querySelectorAll("[data-snowdrop=sidebar] [data-row-id]")].map((e) => e.getAttribute("data-row-id"))')
    last_chat, before = shown[-1], shown[-2]
    archive_row(page, last_chat)
    settle(page, 300)
    page.expect(f'document.activeElement === document.querySelector({row_button(before)!r})', 'focus did not go to the previous row')


@journey(query='journeyCatchUp=held')
def archiving_a_chat_while_catching_up_takes_effect_at_once(page):
    """The sidebar is held for a catch-up and the user archives a chat: its row leaves at once (what the user does is not held), the others keep the order they held, and the hold itself goes on."""
    rows = f'[...document.querySelectorAll({ROWS!r})].map((e) => e.getAttribute("data-conversation-id"))'
    before = page.eval(rows)
    page.expect('__journey.state().catchingUp', 'the catch-up is not on')
    after = json.dumps(before[:2] + before[3:], separators=(',', ':'))
    archive_row(page, before[2])
    page.expect(f'JSON.stringify({rows}) === {json.dumps(after)}', 'the row did not leave, or the others moved')
    page.expect('__journey.state().catchingUp', 'the archive ended the hold')
    page.eval('__journey.caughtUp()')


@journey()
def deleted_on_the_phone_open_chat_is_unselected(page):
    """A message request is open and the phone deletes it: nothing is selected any more, the pane shows what it shows with no chat picked, and focus is not left on the page (a stale selection kept an empty pane)."""
    conversation = page.eval('__journey.conversationId("request-dm")')
    page.click(f'[data-conversation-id="{conversation}"]')
    page.wait_for('!!document.querySelector("[data-snowdrop=message-request]")')
    emit(page, 'messageRequestResponse', {'conversationId': conversation, 'answer': 'delete', 'at': 4000000000000})
    page.wait_for('__journey.state().selected === null')
    page.expect('document.querySelector("[data-snowdrop=message-pane] h1")?.textContent === "Pick a conversation"', 'the pane is not the empty one')
    settle(page, 400)
    page.expect(NOT_BODY, 'focus fell to the page when the open chat was deleted')


@journey()
def narrowing_hides_the_focused_sidebar_row_and_focus_goes_to_the_composer(page):
    """Focus is on a sidebar row when the window narrows below 760 px and the sidebar moves into the (closed) drawer: focus goes to the composer, not the page."""
    open_conversation(page, 'dm-priya')
    page.wait_for(ON_SIDEBAR_ROW)
    page.resize(700, 800)
    page.wait_for('!document.querySelector("[data-snowdrop=sidebar]")')
    settle(page, 300)
    page.expect(IN_COMPOSER, 'focus did not go to the composer')


@journey(settings={'behaviour': {'focusComposerOnOpen': False}})
def drawer_pick_lands_on_the_message_list(page):
    """The narrow navigation drawer: picking a chat closes it and focus goes to the message list (as opening from the keyboard does), not the menu button."""
    page.resize(700, 800)
    page.click(HAMBURGER)
    page.wait_for(DRAWER)
    page.wait_for('document.getAnimations().every((a) => a.playState !== "running")')  # the drawer has slid in
    open_conversation(page, 'dm-priya')
    page.wait_for(f'!({DRAWER})')
    page.wait_for(ON_LIST, 3000)
    page.expect_stays(ON_LIST, 600)


@journey(settings={'behaviour': {'focusComposerOnOpen': True}})
def drawer_pick_lands_on_the_composer_when_that_is_the_setting(page):
    """The narrow drawer with "Focus the message box when opening a conversation" on: picking a chat puts focus in the composer."""
    page.resize(700, 800)
    page.click(HAMBURGER)
    page.wait_for(DRAWER)
    page.wait_for('document.getAnimations().every((a) => a.playState !== "running")')  # the drawer has slid in
    open_conversation(page, 'dm-priya')
    page.wait_for(f'!({DRAWER})')
    page.wait_for(IN_COMPOSER, 3000)
    page.expect_stays(IN_COMPOSER, 600)


# ------------------------------------------------------------------ spaces, folders and categories

TILE = '[data-snowdrop=rail] button[aria-label^="{}"]'
CATEGORY_HEADER = '[data-snowdrop=sidebar] [data-snowdrop=section-header] button'
FOLDER_HEADER = '[data-snowdrop=rail] button[aria-label^="Collapse"]'


def make_folder(page, first, second):
    """A folder of two spaces, made the keyboard way: the first space's menu, Add to folder, New folder with the second."""
    open_menu(page, TILE.format(first))
    click_menu_item(page, 'Add to folder')
    page.wait_for('[...document.querySelectorAll("[role=menuitem]")].some((e) => e.textContent.includes("New folder with"))')
    click_menu_item(page, f'New folder with {second}')
    page.wait_for(f'!!document.querySelector({FOLDER_HEADER!r})')
    quiet(page)


@journey()
def folder_collapse_by_keyboard_keeps_focus_off_the_page(page):
    """A folder of two spaces on the rail, focus on its header, Enter: the folder collapses into one tile and focus is not left on the page (M15, a focused thing that leaves hands focus on)."""
    make_folder(page, 'Work', 'Climbing')
    page.eval(f'(document.querySelector({FOLDER_HEADER!r}).focus(), 1)')
    page.key('Enter')
    page.wait_for('!document.querySelector(\'[data-snowdrop=rail] button[aria-label^="Collapse"]\')')
    quiet(page)
    page.expect(NOT_BODY, 'focus fell to the page when the folder collapsed')


@journey()
def deleting_a_category_keeps_focus_off_the_page(page):
    """A space with two categories, the first one's header menu opened from the keyboard and Delete category chosen: its chats join the next category and focus is not left on the page."""
    select_space(page, 'Climbing')
    page.wait_for('document.querySelectorAll("[data-snowdrop=sidebar] section").length === 2')
    open_menu(page, '[data-snowdrop=sidebar] section:nth-of-type(1) [data-snowdrop=section-header] button')
    click_menu_item(page, 'Delete category')
    page.wait_for('document.querySelectorAll("[data-snowdrop=sidebar] section").length === 1')
    quiet(page)
    page.expect(NOT_BODY, 'focus fell to the page when the category was deleted')


@journey()
def collapsed_category_with_nothing_showing_can_be_reached_by_tab(page):
    """A space whose only category is collapsed with nothing pinned, everything read and no chat open shows no row: Tab from the space's title button still reaches something in the list (its header), so the category can be expanded from the keyboard."""
    select_space(page, 'Family')
    page.wait_for('!!document.querySelector("[data-snowdrop=sidebar] [data-conversation-id]")')
    family = page.eval('__journey.conversationId("family")')
    open_menu(page, row_button(family))
    click_menu_item(page, 'Unpin')
    page.wait_for(f'!document.querySelector({row_button(family)!r})?.getAttribute("aria-label").includes("pinned")')
    open_menu(page, TILE.format('Family'))
    click_menu_item(page, 'Mark all as read')
    page.wait_for('!document.querySelector(\'[data-snowdrop=rail] button[aria-label^="Family,"]\')')
    click_text_starting(page, CATEGORY_HEADER, 'Chats')
    page.wait_for('!document.querySelector("[data-snowdrop=sidebar] [data-conversation-id]")')
    page.eval('(document.querySelector("[data-snowdrop=sidebar-header] button").focus(), 1)')
    page.key('Tab')
    page.expect('!!document.activeElement?.closest("[data-snowdrop=conversation-list]")', 'Tab did not reach the collapsed category')


def book_nook(page):
    """The Book Nook group's id (a group that lives in Home)."""
    return page.eval('__journey.conversationId("books")')


@journey()
def row_menu_move_to_space_keeps_focus_off_the_page(page):
    """A Home row's menu opened from the keyboard and Move to space, Family chosen: the row leaves Home and focus is not left on the page (M15, a row that disappears)."""
    chat = book_nook(page)
    open_menu(page, row_button(chat))
    click_menu_item(page, 'Move to space')
    click_menu_item(page, 'Family')
    page.wait_for(f'!document.querySelector({row_button(chat)!r})')
    quiet(page)
    page.expect(NOT_BODY, 'focus fell to the page when the chat moved to a space')


@journey()
def row_menu_archive_keeps_focus_off_the_page(page):
    """A Home row's menu opened from the keyboard and Archive chosen: the row leaves the list and focus is not left on the page (M15, as for the Archive button on the row)."""
    chat = book_nook(page)
    open_menu(page, row_button(chat))
    click_menu_item(page, 'Archive')
    page.wait_for(f'!document.querySelector({row_button(chat)!r})')
    quiet(page)
    page.expect(NOT_BODY, 'focus fell to the page when the chat was archived')


@journey()
def mention_from_the_inbox_opens_the_chat_in_its_space(page):
    """In Home, a mention of a chat that lives in the Work space is picked from the Mentions inbox: the Work space is selected with the chat open in it, as the switcher and search do, not Home with a chat Home does not list."""
    open_conversation(page, 'dm-priya')
    page.click('[data-snowdrop=chat-header] button[aria-label="Mentions"]')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.includes("Release Train"))')
    click_text_starting(page, '[role=dialog] button', '#Orchard \u00b7 Release')
    release = page.eval('__journey.conversationId("orchard-release")')
    page.wait_for(f'__journey.state().selected === {release!r}')
    quiet(page)
    page.expect('document.querySelector("[data-snowdrop=rail] [aria-current=page]")?.getAttribute("aria-label").startsWith("Work")', 'the chat did not open in its own space')


@journey()
def pinned_row_stays_when_its_category_collapses(page):
    """A chat pinned in a space (it shows the pin), everything read, its only category collapsed: the pinned row is still listed (S5, pinned rows stay visible when the section is collapsed)."""
    select_space(page, 'Family')
    page.wait_for('!!document.querySelector("[data-snowdrop=sidebar] [data-conversation-id]")')
    cousins = page.eval('__journey.conversationId("cousins")')
    open_menu(page, row_button(cousins))
    click_menu_item(page, 'Pin to top')
    page.wait_for(f'document.querySelector({row_button(cousins)!r})?.getAttribute("aria-label").includes("pinned")')
    open_menu(page, TILE.format('Family'))
    click_menu_item(page, 'Mark all as read')
    page.wait_for('!document.querySelector(\'[data-snowdrop=rail] button[aria-label^="Family,"]\')')
    click_text_starting(page, CATEGORY_HEADER, 'Chats')
    quiet(page)
    page.expect(f'!!document.querySelector({row_button(cousins)!r})', 'the pinned row went when its category collapsed')


CONVERSATION_MIME = 'application/x-snowdrop-conversation'


@journey()
def dropping_a_chat_on_its_own_space_leaves_it_in_its_category(page):
    """A chat in a space's second category is dragged onto that space's own rail tile: it stays in its category (the drop changes the space, and nothing else about where the chat is filed). The drop is played as the page's own drag events, as the harness has no native drag."""
    select_space(page, 'Climbing')
    trips = page.eval('__journey.conversationId("crux-trips")')
    page.wait_for(f'!!document.querySelector({row_button(trips)!r})')
    in_trips = f'!!document.querySelector(\'[data-snowdrop=sidebar] section[aria-label="Trips"] [data-row-id="{trips}"]\')'
    page.expect(in_trips, 'the chat is not in Trips to begin with')
    page.eval(
        f'(() => {{ const dt = new DataTransfer(); dt.setData({CONVERSATION_MIME!r}, {trips!r});'
        f' const tile = document.querySelector({TILE.format("Climbing")!r});'
        ' for (const type of ["dragenter", "dragover", "drop"]) tile.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));'
        ' return 1; })()'
    )
    quiet(page)
    page.expect(in_trips, 'the chat left its category')
    page.expect('!document.querySelector("[data-sonner-toast]")', 'a toast says the chat moved')


@journey()
def delete_space_dialog_counts_only_the_chats_it_has(page):
    """A message request filed in a space is deleted on the phone: the space lists three chats, and its Delete dialog says three move back to Home, not four."""
    request = page.eval('__journey.conversationId("request-dm")')
    open_menu(page, row_button(request))
    click_menu_item(page, 'Move to space')
    click_menu_item(page, 'Family')
    select_space(page, 'Family')
    page.wait_for(f'!!document.querySelector({row_button(request)!r})')
    emit(page, 'messageRequestResponse', {'conversationId': request, 'answer': 'delete', 'at': 4000000000000})
    page.wait_for(f'!document.querySelector({row_button(request)!r})')
    page.expect('document.querySelectorAll("[data-snowdrop=sidebar] [data-row-id]").length === 3', 'the space does not list three chats')
    open_menu(page, TILE.format('Family'))
    click_menu_item(page, 'Delete space')
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.expect('document.querySelector("[role=dialog]").textContent.includes("Its 3 conversations")', 'the dialog counts a chat that is not there')


@journey()
def deleting_a_space_in_the_drawer_keeps_focus_in_the_drawer(page):
    """Below 760 px the navigation drawer is open and a space is deleted from its tile's menu: the drawer stays open (nothing was picked) and focus stays inside it, not on the header button behind it."""
    select_space(page, 'Family')
    page.wait_for('!!document.querySelector("[data-snowdrop=sidebar] [data-conversation-id]")')
    page.resize(700, 800)
    page.click(HAMBURGER)
    page.wait_for(DRAWER)
    quiet(page)
    open_menu(page, TILE.format('Family'))
    click_menu_item(page, 'Delete space')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Delete space")')
    click_text_starting(page, '[role=dialog] button', 'Delete space')
    page.wait_for('![...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Delete space")')
    quiet(page)
    page.expect(DRAWER, 'the drawer closed')
    page.expect('!!document.activeElement?.closest("[data-snowdrop=drawer]")', 'focus is behind the open drawer')


@journey()
def folder_menu_actions_keep_focus_on_the_tiles(page):
    """A folder made from a space's menu (focus stays on that space's tile, now inside the folder), collapsed from its own menu (on the folder's tile), expanded by Enter on it (on its header) and a space taken out of it from the tile's menu (on that space's tile): focus is never left on the page (M15, a tile that is mounted anew)."""
    make_folder(page, 'Work', 'Climbing')
    page.expect(f'document.activeElement?.getAttribute("aria-label")?.startsWith("Work")', 'focus left the space that was filed into the folder')
    open_menu(page, FOLDER_HEADER)
    click_menu_item(page, 'Collapse folder')
    page.wait_for('!document.querySelector(\'[data-snowdrop=rail] button[aria-label^="Collapse"]\')')
    quiet(page)
    page.expect('document.activeElement?.getAttribute("aria-label")?.includes("folder")', 'focus left the folder when its menu collapsed it')
    page.key('Enter')
    page.wait_for(f'!!document.querySelector({FOLDER_HEADER!r})')
    quiet(page)
    page.expect('document.activeElement?.getAttribute("aria-label")?.startsWith("Collapse")', 'focus left the folder when Enter expanded it')
    open_menu(page, TILE.format('Work'))
    click_menu_item(page, 'Remove from folder')
    page.wait_for(f'!document.querySelector({FOLDER_HEADER!r})')
    quiet(page)
    page.expect('document.activeElement?.getAttribute("aria-label")?.startsWith("Work")', 'focus left the space that was taken out of the folder')


@journey()
def row_menu_remove_from_space_keeps_focus_off_the_page(page):
    """A chat in a space, its menu opened from the keyboard and Remove from space chosen: the row leaves the space's list and focus is not left on the page (M15)."""
    select_space(page, 'Family')
    cousins = page.eval('__journey.conversationId("cousins")')
    page.wait_for(f'!!document.querySelector({row_button(cousins)!r})')
    open_menu(page, row_button(cousins))
    click_menu_item(page, 'Move to space')
    click_menu_item(page, 'Remove from space')
    page.wait_for(f'!document.querySelector({row_button(cousins)!r})')
    quiet(page)
    page.expect(NOT_BODY, 'focus fell to the page when the chat left its space')


@journey()
def row_menu_move_to_category_keeps_focus_on_the_chat(page):
    """A chat in a space's first category, its menu opened from the keyboard and Move to category, Trips chosen: the row is mounted again under the other heading and keeps the focus."""
    select_space(page, 'Climbing')
    crux = page.eval('__journey.conversationId("crux")')
    page.wait_for(f'!!document.querySelector({row_button(crux)!r})')
    open_menu(page, row_button(crux))
    click_menu_item(page, 'Move to category')
    click_menu_item(page, 'Trips')
    page.wait_for(f'!!document.querySelector(\'[data-snowdrop=sidebar] section[aria-label="Trips"] [data-row-id="{crux}"]\')')
    quiet(page)
    page.expect(f'document.activeElement?.getAttribute("data-conversation-id") === {crux!r}', 'focus left the chat that was moved to another category')


@journey()
def dropping_a_group_on_home_while_already_in_home_does_nothing(page):
    """A group that lives in Home is dragged onto the Home tile: nothing moves and no toast says it did (the drop is played as the page's own drag events)."""
    chat = book_nook(page)
    page.eval(
        f'(() => {{ const dt = new DataTransfer(); dt.setData({CONVERSATION_MIME!r}, {chat!r});'
        f' const tile = document.querySelector({TILE.format("Home")!r});'
        ' for (const type of ["dragenter", "dragover", "drop"]) tile.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));'
        ' return 1; })()'
    )
    quiet(page)
    page.expect_stays('!document.querySelector("[data-sonner-toast]")', 600)


@journey()
def moving_the_open_chat_to_a_space_keeps_it_open_and_selected_there(page):
    """The open Home chat is moved to Family from its menu: it stays open where the user is, and in Family it is the selected chat, not "Pick a conversation"; then it is taken out of the space and Home shows it selected again."""
    chat = open_conversation(page, 'books')
    open_menu(page, row_button(chat))
    click_menu_item(page, 'Move to space')
    click_menu_item(page, 'Family')
    page.wait_for(f'!document.querySelector({row_button(chat)!r})')
    quiet(page)
    page.expect(f'__journey.state().selected === {chat!r} && !!document.querySelector({COMPOSER!r})', 'the chat closed where the user was')
    select_space(page, 'Family')
    page.wait_for(f'!!document.querySelector({row_button(chat)!r})')
    page.expect(f'__journey.state().selected === {chat!r}', 'the chat is not selected in its new space')
    open_menu(page, row_button(chat))
    click_menu_item(page, 'Move to space')
    click_menu_item(page, 'Remove from space')
    page.wait_for(f'!document.querySelector({row_button(chat)!r})')
    quiet(page)
    page.expect(f'__journey.state().selected === {chat!r} && !!document.querySelector({COMPOSER!r})', 'the chat closed where the user was')
    page.click(TILE.format('Home'))
    page.wait_for(f'!!document.querySelector({row_button(chat)!r})')
    page.expect(f'__journey.state().selected === {chat!r}', 'the chat is not selected in Home')


@journey()
def deleting_the_viewed_space_keeps_its_open_chat_open_in_home(page):
    """A chat is open in Family and the space is deleted: Home is shown with that chat open and selected."""
    select_space(page, 'Family')
    cousins = page.eval('__journey.conversationId("cousins")')
    page.wait_for(f'!!document.querySelector({row_button(cousins)!r})')
    page.click(row_button(cousins))
    page.wait_for(f'__journey.state().selected === {cousins!r}')
    open_menu(page, TILE.format('Family'))
    click_menu_item(page, 'Delete space')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Delete space")')
    click_text_starting(page, '[role=dialog] button', 'Delete space')
    page.wait_for('!document.querySelector("[role=dialog]")')
    quiet(page)
    page.expect('document.querySelector("[data-snowdrop=rail] [aria-current=page]")?.getAttribute("aria-label").startsWith("Home")', 'Home is not shown')
    page.expect(f'__journey.state().selected === {cousins!r} && !!document.querySelector({row_button(cousins)!r})', 'the chat is not open and listed in Home')
