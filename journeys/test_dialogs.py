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
