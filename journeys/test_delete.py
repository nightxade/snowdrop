from common import MESSAGE, open_conversation, send
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
