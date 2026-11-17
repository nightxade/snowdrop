from common import JUMP_PILL, MESSAGE, SCROLLER, LAST_MESSAGE, open_conversation
from harness import journey

# The message whose top edge is nearest the scroller's middle, remembered by id.
PICK_ANCHOR = f"""(() => {{
  const s = document.querySelector({SCROLLER!r}).getBoundingClientRect();
  const mid = s.top + s.height / 2;
  const rows = [...document.querySelectorAll({MESSAGE!r})];
  rows.sort((a, b) => Math.abs(a.getBoundingClientRect().top - mid) - Math.abs(b.getBoundingClientRect().top - mid));
  return rows[0].getAttribute('data-message-id');
}})()"""


def top_of(message_id):
    return f'document.querySelector(\'[data-message-id="{message_id}"]\')?.getBoundingClientRect().top'


def at_bottom():
    return f'(() => {{ const s = document.querySelector({SCROLLER!r}); return !!s && s.scrollHeight - s.scrollTop - s.clientHeight < 3; }})()'


@journey()
def receive_while_scrolled_up(page):
    """Scrolled up in a long chat, arrivals don't move the view and the jump pill appears; at the bottom they are followed."""
    open_conversation(page, 'dm-priya')
    page.eval("__journey.deliver({ conversation: 'dm-priya', count: 40, spacingMs: 20, text: 'filler' })")
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("filler 40")')

    page.scroll(SCROLLER, -700)
    page.wait_for(f'!{at_bottom()}')
    anchor = page.eval(PICK_ANCHOR)
    before = page.eval(top_of(anchor))
    page.eval("__journey.deliver({ conversation: 'dm-priya', count: 3, spacingMs: 250, text: 'while away' })")
    page.wait_for(f'!!document.querySelector({JUMP_PILL!r})')
    page.expect_stays(f'Math.abs({top_of(anchor)} - {before}) < 2', 1500)

    page.click(JUMP_PILL)
    page.wait_for(at_bottom())
    page.wait_for(f'!document.querySelector({JUMP_PILL!r})')
    page.eval("__journey.deliver({ conversation: 'dm-priya', count: 2, spacingMs: 200, text: 'at the bottom' })")
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("at the bottom 2")')
    page.expect_stays(at_bottom(), 600)
