from common import COMPOSER, IN_COMPOSER, click_text, emit, forget_expected_send_failures, is_current, open_conversation, quiet, send, settle
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


@journey()
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


@journey()
def alt_arrow_in_settings_leaves_the_open_chat(page):
    """Settings open over a chat: Alt+Down does not switch the chat behind the dialog."""
    open_conversation(page, 'dm-priya')
    opened = page.eval('__journey.state().selected')
    page.key(',', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    settle(page, 300)
    page.key('ArrowDown', ['alt'])
    settle(page, 700)
    page.expect(f'__journey.state().selected === {opened!r}', 'Alt+Down changed the chat behind Settings')


@journey()
def request_answered_on_the_phone_under_an_open_dialog(page):
    """Block or Delete on a message request asks first; the phone accepts the request meanwhile: the question goes with the bar, and focus goes to the fallback (what had it before, else the composer), not the page."""
    conversation = page.eval('__journey.conversationId("request-dm")')
    page.click(f'[data-conversation-id="{conversation}"]')
    page.wait_for('!!document.querySelector("[data-snowdrop=message-request]")')
    click_text(page, '[data-snowdrop=message-request] button', 'Delete')
    page.wait_for('!!document.querySelector("[role=alertdialog], [role=dialog]")')
    emit(page, 'messageRequestResponse', {'conversationId': conversation, 'answer': 'accept', 'at': 4000000000000})
    page.wait_for(f'!document.querySelector("[role=alertdialog], [role=dialog]") && !!document.querySelector({COMPOSER!r})')
    settle(page, 500)
    page.expect('document.activeElement !== document.body', 'focus fell to the page when the request was answered under its dialog')


@journey()
def dialogs_of_a_message_close_when_it_is_deleted_for_everyone(page):
    """The delete question or Message details is open on a message; the sender deletes it for everyone from another device: the dialog goes with the message, and focus is not left on the page (M15)."""
    open_conversation(page, 'dm-priya')
    conversation = page.eval('__journey.conversationId("dm-priya")')
    dialog = 'document.querySelector("[role=alertdialog], [role=dialog]")'
    for text, open_dialog in (
        ('delete question', lambda: page.key('Delete')),
        ('details question', lambda: (page.key('Enter', ['ctrl']), page.wait_for('!!document.querySelector("[role=menu]")'),
                                      click_text(page, '[role=menu] [role=menuitem]', 'Message details'))),
    ):
        send(page, text)
        page.key('Escape')
        page.wait_for(is_current(0))
        author, _, sent = page.eval('document.activeElement.getAttribute("data-message-id")').rpartition(':')
        open_dialog()
        page.wait_for(f'!!{dialog}')
        emit(page, 'messageDeleted', {'conversationId': conversation, 'authorId': author, 'targetSentAt': int(sent)})
        page.wait_for(f'!{dialog}')
        settle(page, 500)
        page.expect('document.activeElement !== document.body', f'focus fell to the page when the {text} dialog closed under it')


@journey()
def settings_nav_item_with_focus_hides_when_the_window_narrows(page):
    """Settings open with focus on a section of its nav and a page showing; the window narrows below 760 px, where a page shows without the nav: focus goes to the page's heading, not the page (M15)."""
    page.key(',', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    click_text(page, '[role=dialog] button', 'Appearance')
    page.wait_for('document.activeElement?.getAttribute("data-page-id") === "appearance"')
    page.resize(700, 800)
    settle(page, 500)
    page.expect('document.activeElement?.hasAttribute("data-page-heading") === true', 'focus did not go to the page heading')


DIALOG = '!!document.querySelector("[role=dialog]")'
REVIEW = '[...document.querySelectorAll("[data-snowdrop=message] button")].some((b) => b.textContent.trim() === "Review safety number")'


def send_to_annika(page, text):
    """Sends to Annika, whose changed key refuses the message a moment after it is sent."""
    page.eval('__journey.setSendDelay(500)')
    open_conversation(page, 'dm-annika')
    page.click(COMPOSER)
    page.type(text)
    page.key('Enter')
    page.wait_for('!!document.querySelector("[data-snowdrop=message][data-pending]")')


@journey()
def a_failed_send_opens_the_safety_number_dialog_when_the_user_is_idle(page):
    """Send to Annika (her safety number changed) and do nothing: when the send fails, the Safety Number Changes dialog opens by itself."""
    send_to_annika(page, 'hello')
    page.wait_for(DIALOG, 5000)
    forget_expected_send_failures(page)


@journey()
def a_failed_send_does_not_take_focus_from_typing(page):
    """Send to Annika and keep typing the next message: when the send fails, no dialog opens over it and focus stays in the composer with the text intact; the failed message says so and still offers Review safety number."""
    send_to_annika(page, 'hello')
    page.type('and more')
    page.wait_for(REVIEW, 5000)
    quiet(page)
    page.expect_stays('!document.querySelector("[role=dialog]")', 800)
    page.expect(f'{IN_COMPOSER} && document.querySelector({COMPOSER!r}).value === "and more"', 'focus or the typed text was taken')
    forget_expected_send_failures(page)
