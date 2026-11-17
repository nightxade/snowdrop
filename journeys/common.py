"""Steps and selectors shared by the journeys."""

COMPOSER = '[data-snowdrop=composer-input]'
MESSAGE = '[data-snowdrop=message]'
# The message list's scroll container (react-virtuoso's).
SCROLLER = '[data-snowdrop=message-pane] [data-virtuoso-scroller]'
JUMP_PILL = '[data-snowdrop=jump-to-present]'
# A sidebar row's preview line (a CSS-module class: only the stable prefix is matched).
PREVIEW = '[data-snowdrop=conversation-row] [class*="_previewText_"]'

# The message currently showing at the end of the list, as a JS expression (undefined while there is none: use `?.`).
LAST_MESSAGE = f'(() => {{ const m = document.querySelectorAll({MESSAGE!r}); return m[m.length - 1]; }})()'


def open_conversation(page, key):
    """Clicks a conversation in the sidebar, as a user would, and waits for its messages."""
    conversation = page.eval(f'__journey.conversationId({key!r})')
    page.click(f'[data-conversation-id="{conversation}"]')
    page.wait_for(f'!!document.querySelector({COMPOSER!r}) && document.querySelectorAll({MESSAGE!r}).length > 0')
    return conversation


def send(page, text):
    """Types into the composer and presses Enter; waits until the message is in the list and sent
    (while it is pending the row is replaced when the send completes, which would take the focus with it)."""
    page.click(COMPOSER)
    page.type(text)
    page.key('Enter')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes({text!r}) && {LAST_MESSAGE}.hasAttribute("data-pending") === false')
