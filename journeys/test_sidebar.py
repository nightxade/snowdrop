from common import COMPOSER, MESSAGE, PREVIEW, click_text_starting, open_conversation, send, settle
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
