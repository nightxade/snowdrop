from common import COMPOSER, LAST_MESSAGE, SCROLLER, open_conversation, send
from harness import journey


@journey()
def send_a_message(page):
    """Type and press Enter: the message lands at the bottom, in view, and the composer keeps focus."""
    open_conversation(page, 'dm-priya')
    send(page, 'hello from the journey')
    page.wait_for(
        f"""(() => {{
          const m = {LAST_MESSAGE}.getBoundingClientRect();
          const s = document.querySelector({SCROLLER!r}).getBoundingClientRect();
          return m.top >= s.top - 1 && m.bottom <= s.bottom + 1;
        }})()"""
    )
    page.expect(f'document.activeElement === document.querySelector({COMPOSER!r})', 'the composer lost focus')
