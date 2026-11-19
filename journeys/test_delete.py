from common import COMPOSER, LAST_MESSAGE, MESSAGE, emit, open_conversation, send, settle
from harness import journey

DELETE = '[data-snowdrop=hover-bar] button[aria-label^="Delete"]'
NO_DIALOG = '!document.querySelector("[role=dialog], [role=alertdialog]")'


@journey()
def shift_delete_across_messages(page):
    """Shift pressed once and held: the quick delete works on three messages in a row, never asking."""
    open_conversation(page, 'dm-priya')
    for text in ('first', 'second', 'third'):
        send(page, text)
    ids = page.eval(f'[...document.querySelectorAll({MESSAGE!r})].slice(-3).map((e) => e.getAttribute("data-message-id"))')
    page.hover(f'[data-message-id="{ids[2]}"]')
    page.key_down('Shift')  # pressed once, never released in this journey
    for step, message in enumerate(reversed(ids), start=1):
        row = f'[data-message-id="{message}"]'
        page.hover(row)  # a plain pointer move: the bar must still know Shift is down
        page.wait_for(f'!!document.querySelector({DELETE!r})')
        page.click(DELETE)
        page.wait_for(f'document.querySelector({row!r})?.textContent.includes("You deleted this message")')
        page.expect(NO_DIALOG, f'delete {step} asked for confirmation')


@journey()
def shift_delete_on_a_message_focused_by_click(page):
    """Click a message of yours, move the pointer off it, Shift+Delete: it is deleted without a question (M3, holding Shift skips it), as it is on a message reached with the keyboard."""
    open_conversation(page, 'dm-priya')
    for text in ('first', 'second'):
        send(page, text)
    first = page.eval(f'[...document.querySelectorAll({MESSAGE!r})].at(-2).getAttribute("data-message-id")')
    row = f'[data-message-id="{first}"]'
    page.click(row)
    page.wait_for(f'document.activeElement === document.querySelector({row!r})')
    page.hover(COMPOSER)
    settle(page, 300)
    page.key('Delete', ['shift'])
    settle(page, 600)
    page.expect(NO_DIALOG, 'Shift+Delete asked for confirmation')
    page.wait_for(f'document.querySelector({row!r})?.textContent.includes("You deleted this message")', 3000)


@journey()
def edit_closes_when_its_message_is_deleted_on_another_device(page):
    """Your message is open in the editor with text typed; the same message is deleted for everyone from another device: the editor closes with a "This message was deleted" toast and focus goes to the message's row, not the page (M9)."""
    open_conversation(page, 'dm-priya')
    send(page, 'about to vanish')
    page.click(COMPOSER)
    page.key('ArrowUp')
    page.wait_for('document.activeElement?.matches("[data-snowdrop=message] textarea")')
    page.type(' and more')
    author, _, sent = page.eval(f'{LAST_MESSAGE}.getAttribute("data-message-id")').rpartition(':')
    row = f'[data-message-id="{author}:{sent}"]'
    emit(page, 'messageDeleted', {'conversationId': page.eval('__journey.conversationId("dm-priya")'), 'authorId': author, 'targetSentAt': int(sent)})
    page.wait_for('!document.querySelector("[data-snowdrop=message] textarea")')
    page.wait_for('document.body.textContent.includes("This message was deleted")')
    page.wait_for(f'document.activeElement === document.querySelector({row!r})', 1500)
    page.expect_stays(f'document.activeElement === document.querySelector({row!r})', 500)
