"""When Snowdrop speaks (DECISIONS N1, N4). The page's `Notification` is a recording stand-in (`notifications=True`): what the app
asks it to show is what a desktop notification would be. Window focus goes in as the GTK focus event a real window gets."""
from common import (
    DISTANCE,
    SLACK,
    fill,
    open_conversation,
    scroll_to_distance,
    send,
    settle,
)
from harness import journey

HELD = '__journey.state().notificationsHeld'
COUNT = 'window.__notified.length'
SAYS = lambda text: f'window.__notified.some((n) => n.body.includes({text!r}))'


def says(page, text):
    return page.eval(SAYS(text))


def quiet_for(page, ms=700):
    """The number of notifications does not grow for `ms`."""
    shown = page.eval(COUNT)
    page.expect_stays(f'{COUNT} === {shown}', ms)


# ------------------------------------------------------------------ N1


@journey(query='journeyCatchUp=held', notifications=True)
def notifications_wait_for_the_end_of_catch_up(page):
    """During a held catch-up (at launch, and again on a later reconnect) arrivals in any chat show no notification; the end of the catch-up does not replay them; a message after it does."""
    page.expect(HELD, 'no hold at the start of the catch-up')
    for conversation in ('dm-oren', 'dm-ines', 'dm-rafferty'):
        page.eval(f'void __journey.deliver({{ conversation: {conversation!r}, count: 3, spacingMs: 100, text: "backlog" }})')
        page.expect_stays(f'{HELD} && {COUNT} === 0', 2200)

    page.eval('__journey.caughtUp()')
    page.wait_for(f'!({HELD})')
    quiet_for(page)  # the held ones are not announced late
    page.expect(f'{COUNT} === 0', 'the backlog was announced after the catch-up')

    page.eval('void __journey.deliver({ conversation: "dm-oren", text: "after the catch-up", exact: true })')
    page.wait_for(SAYS('after the catch-up'))
    page.expect(f'{COUNT} === 1')

    # A later connect (wake from sleep): held again until its own end.
    page.eval('__journey.startCatchUp()')
    page.wait_for(HELD)
    page.eval('void __journey.deliver({ conversation: "dm-ines", count: 3, spacingMs: 100, text: "slept through" })')
    page.expect_stays(f'{HELD} && {COUNT} === 1', 1500)
    page.eval('__journey.caughtUp()')
    page.wait_for(f'!({HELD})')
    page.eval('void __journey.deliver({ conversation: "dm-ines", text: "awake again", exact: true })')
    page.wait_for(SAYS('awake again'))
    page.expect(f'{COUNT} === 2 && !{SAYS("slept through")}')


# ------------------------------------------------------------------ N4


def arrive(page, conversation, text):
    page.eval(f'void __journey.deliver({{ conversation: {conversation!r}, text: {text!r}, exact: true }})')


@journey(notifications=True)
def looking_at_a_chat_is_quiet(page):
    """Window focused, chat open and at the bottom: a message there shows nothing, and neither does your own send. The same chat scrolled up, another chat, and the window blurred each do show one."""
    open_conversation(page, 'dm-priya')
    page.expect('__journey.state().windowFocused', 'the app does not think its window is focused')

    arrive(page, 'dm-priya', 'seen as it came')
    page.expect_stays(f'{COUNT} === 0', 900)
    send(page, 'my own message')
    page.expect_stays(f'{COUNT} === 0', 600)

    # Another chat: announced.
    arrive(page, 'dm-oren', 'in another chat')
    page.wait_for(SAYS('in another chat'))
    page.expect(f'{COUNT} === 1')

    # The same chat, scrolled away from the newest message: announced.
    fill(page)
    slack = page.eval(SLACK)
    scroll_to_distance(page, slack + 100)
    page.wait_for('__journey.state().scrolledUp')
    arrive(page, 'dm-priya', 'while scrolled up')
    page.wait_for(SAYS('while scrolled up'))
    page.expect(f'{COUNT} === 2')

    # Back at the bottom: quiet again.
    page.eval(f'const s = document.querySelector("[data-snowdrop=message-pane] [data-virtuoso-scroller]"); s.scrollTop = s.scrollHeight; return 1;')
    page.wait_for(f'!__journey.state().scrolledUp && {DISTANCE} < 3')
    settle(page, 300)
    arrive(page, 'dm-priya', 'at the bottom again')
    page.expect_stays(f'{COUNT} === 2', 900)

    # The window loses focus (the user is in another app): the open chat is announced; refocused, quiet.
    page.window_focus(False)
    page.wait_for('!__journey.state().windowFocused')
    arrive(page, 'dm-priya', 'window blurred')
    page.wait_for(SAYS('window blurred'))
    page.expect(f'{COUNT} === 3')
    page.window_focus(True)
    page.wait_for('__journey.state().windowFocused')
    arrive(page, 'dm-priya', 'window back')
    page.expect_stays(f'{COUNT} === 3', 900)
