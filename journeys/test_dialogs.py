from common import COMPOSER, click_text, is_current, open_conversation, send
from harness import journey

NEW_MESSAGE = '[data-snowdrop=sidebar-header] button[aria-label="New message"]'
SETTINGS = '[data-snowdrop=user-panel] button[aria-label="Settings"]'


def returns_focus_to(page, button):
    """Clicks `button`, waits for the dialog, closes it with Esc: focus must be back on `button`."""
    page.click(button)
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(f'document.activeElement === document.querySelector({button!r})')


@journey()
def dialog_returns_focus_to_its_button(page):
    """A dialog opened from a button gives focus back to that button when Esc closes it."""
    returns_focus_to(page, NEW_MESSAGE)
    returns_focus_to(page, SETTINGS)


@journey()
def replaced_dialog_returns_focus_to_the_first_opener(page):
    """New message, then New group inside it (one dialog replaces the other): closing the second gives focus back to the New message button, not to the page."""
    page.click(NEW_MESSAGE)
    page.wait_for('!!document.querySelector("[role=dialog]")')
    click_text(page, '[role=dialog] [role=option], [role=dialog] [cmdk-item]', 'New group')
    page.wait_for('/group/i.test(document.querySelector("[role=dialog]")?.getAttribute("aria-label") ?? document.querySelector("[role=dialog]")?.textContent ?? "") && !document.querySelector("[role=dialog] [cmdk-item]")', 5000)
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(f'document.activeElement === document.querySelector({NEW_MESSAGE!r})')
    page.expect_stays(f'document.activeElement === document.querySelector({NEW_MESSAGE!r})', 500)


@journey()
def palette_command_dialog_returns_focus_to_what_had_it(page):
    """From a message: Ctrl+K, a command that opens a dialog (Open settings), Esc: focus goes back to that message, not to <body> or the composer (the palette that held it is gone)."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('Escape')
    page.wait_for(is_current(0))
    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.type('>open settings')
    page.key('Enter')
    page.wait_for('/settings/i.test(document.querySelector("[role=dialog]")?.getAttribute("aria-label") ?? "") || !!document.querySelector("[data-snowdrop=settings]")', 5000)
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(is_current(0))
    page.expect_stays(is_current(0), 500)


@journey(
    known_bug='a dialog opened from a message menu item remembers the menu item as its opener (openerFocus.tsx:67),'
    ' which is gone when the dialog closes, so focus falls to <body> instead of the message',
    fails_at='focus back on the message',
)
def message_menu_dialog_returns_focus_to_the_message(page):
    """On a message: Ctrl+Enter, "Delete for me" from the menu, Esc on the question: focus is back on the message the menu was opened from."""
    open_conversation(page, 'dm-priya')
    send(page, 'menu then dialog')
    page.key('Escape')
    page.wait_for(is_current(0))
    row = f'[data-message-id="{page.eval("document.activeElement.getAttribute(\'data-message-id\')")}"]'
    page.key('Enter', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=menu]")')
    click_text(page, '[role=menu] [role=menuitem]', 'Delete for me')
    page.wait_for('!!document.querySelector("[role=dialog], [role=alertdialog]")')
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog], [role=alertdialog]")')
    page.wait_for(f'document.activeElement === document.querySelector({row!r})', 2000)  # focus back on the message
