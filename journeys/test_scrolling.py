from common import JUMP_PILL, MESSAGE, SCROLLER, LAST_MESSAGE, open_conversation
from functools import partial

from harness import journey as _journey

# These journeys are about scrolling, jumps and rows that move: they run with motion on.
journey = partial(_journey, motion=True)

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
    page.expect_stays(f'Math.abs({top_of(anchor)} - {before}) < 2', 1000)

    page.click(JUMP_PILL)
    page.wait_for(at_bottom())
    page.wait_for(f'!document.querySelector({JUMP_PILL!r})')
    page.eval("__journey.deliver({ conversation: 'dm-priya', count: 2, spacingMs: 200, text: 'at the bottom' })")
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("at the bottom 2")')
    page.expect_stays(at_bottom(), 600)


UNREAD = "__journey.state().conversations.find((c) => c.key === 'dm-priya').unread"
DISTANCE = f'(() => {{ const s = document.querySelector({SCROLLER!r}); return s.scrollHeight - s.scrollTop - s.clientHeight; }})()'


@journey()
def scrolled_part_way_back_stays_unread(page):
    """Arrivals while scrolled up stay unread when the reader comes back near the end but the newest are still below the fold; they are read once the end is on screen."""
    open_conversation(page, 'dm-priya')
    page.eval("__journey.deliver({ conversation: 'dm-priya', count: 40, spacingMs: 20, text: 'filler' })")
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("filler 40")')
    page.scroll(SCROLLER, -900)
    page.wait_for(f'{DISTANCE} > 500')
    page.eval("__journey.deliver({ conversation: 'dm-priya', count: 3, spacingMs: 100, text: 'while away' })")
    page.wait_for(f'{UNREAD} === 3')

    # Back down to just short of the end (inside the follow slack, newest messages out of view).
    slack = page.eval(f'Math.round(document.querySelector({SCROLLER!r}).clientHeight / 2)')
    page.scroll(SCROLLER, page.eval(DISTANCE) - slack + 60)
    page.expect(f'{DISTANCE} > 10 && {DISTANCE} <= {slack}', 'the scroll reached the end; the journey needs to stop short of it')
    page.expect_stays(f'{UNREAD} === 3', 1500)

    page.scroll(SCROLLER, 600)
    page.wait_for(at_bottom())
    page.wait_for(f'{UNREAD} === 0')


@journey()
def arrivals_while_the_window_is_away_stay_unread(page):
    """At the bottom of the open chat with the window unfocused (the user in another app), arrivals stay unread; focusing the window reads them."""
    open_conversation(page, 'dm-priya')
    page.wait_for(at_bottom())
    page.window_focus(False)
    page.wait_for('!__journey.state().windowFocused')
    page.eval("__journey.deliver({ conversation: 'dm-priya', count: 2, spacingMs: 100, text: 'while away' })")
    page.wait_for(f'{UNREAD} === 2')
    page.expect_stays(f'{UNREAD} === 2', 1500)

    page.window_focus(True)
    page.wait_for(f'{UNREAD} === 0')
