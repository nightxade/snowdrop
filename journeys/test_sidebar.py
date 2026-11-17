from common import COMPOSER, MESSAGE, PREVIEW, open_conversation, send
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
