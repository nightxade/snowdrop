"""
A patched signal-cli replays its backlog in bursts, with pauses, and says
"caught up" only when it is done (the demo acts like it: `journeyCatchUp=held`).
The sidebar must hold still for the whole catch-up, however long the pauses.
"""
from common import PREVIEW, quiet, settle
from harness import journey

ROW_BUTTONS = '[data-snowdrop=conversation-row] [data-conversation-id]'
PREVIEW_TEXTS = f'[...document.querySelectorAll({PREVIEW!r})].map((p) => p.textContent)'

# Every preview the sidebar shows says "Loading…" ("Message request" rows say that instead).
ALL_LOADING = f"""(() => {{
  const texts = {PREVIEW_TEXTS};
  return texts.filter((t) => t === 'Loading…').length >= 8
    && texts.every((t) => t === 'Loading…' || t === 'Message request');
}})()"""
NONE_LOADING = f'{PREVIEW_TEXTS}.every((t) => t !== "Loading…")'

# What the sidebar shows per row, in the order shown: its title and badge state (the row's
# label says "unread" or the mention count), whether it carries the unread marker, and its badge text.
STATE = f"""JSON.stringify([...document.querySelectorAll('[data-snowdrop=conversation-row]')].map((row) => [
  row.querySelector('[data-conversation-id]')?.getAttribute('aria-label'),
  row.hasAttribute('data-unread'),
  row.querySelector('[data-variant=mention]')?.textContent ?? '',
]))"""
ORDER = f'JSON.stringify([...document.querySelectorAll({ROW_BUTTONS!r})].map((b) => b.getAttribute("data-conversation-id")))'

# Counted from the app's start, when catching up begins: longer than the 20 s a plain catch-up is capped at.
LONGER_THAN_A_PLAIN_CEILING_MS = 24_000


def burst(page, conversation, text, count=4):
    page.eval(f'void __journey.deliver({{ conversation: {conversation!r}, count: {count}, spacingMs: 150, text: {text!r} }})')


# Slow tier: the run has to outlast the 20 s plain ceiling on the page's real clock. The tracker's
# strict-run and ceiling rules are pinned in CatchUpTracker.test.ts, and the sidebar holding through
# a catch-up is pinned at short scale by the two journeys below.
@journey(query='journeyCatchUp=held', slow=True)
def catch_up_holds_the_sidebar(page):
    """Bursts with long pauses, caught-up after more than 20 s: previews read Loading…, and the order and badges hold throughout; real previews appear after."""
    page.expect(ALL_LOADING, 'the sidebar is not on Loading… at the start')
    page.eval(f'(window.__held = {STATE}, true)')  # kept in the page: failure messages never print what the sidebar shows
    check = f'{ALL_LOADING} && {STATE} === window.__held'
    backlog = [('dm-rafferty', 'rafferty'), ('dm-oren', 'oren'), ('dm-priya', 'priya'), ('allotment', 'the allotment')]
    for conversation, who in backlog:
        burst(page, conversation, f'backlog from {who}')
        page.expect_stays(check, 3500)  # a pause well past the 1.5 s quiet period
    while page.eval('performance.now()') < LONGER_THAN_A_PLAIN_CEILING_MS:
        page.expect_stays(check, 1000)
    page.expect(check)

    page.eval('__journey.caughtUp()')
    page.wait_for(NONE_LOADING)
    for _, who in backlog:
        page.expect(f'{PREVIEW_TEXTS}.some((t) => t.includes("backlog from {who} 4"))', f'no preview shows the newest message from {who}')


@journey(query='journeyCatchUp=held')
def catch_up_keeps_the_order(page):
    """During the catch-up a conversation that receives messages stays where it was."""
    page.eval(f'(window.__held = {ORDER}, true)')
    page.eval("void __journey.deliver({ conversation: 'dm-ines', count: 3, spacingMs: 100, text: 'backlog' })")
    page.expect_stays(f'{ORDER} === window.__held', 2000)


@journey(
    query='journeyCatchUp=held',
)
def catch_up_hold_survives_a_narrow_round_trip(page):
    """During the catch-up a chat receives messages and the window is made narrow (drawer) and wide again: the sidebar still shows the order and badges it held."""
    settle(page, 1500)
    page.eval(f'(window.__held = {ORDER}, true)')
    page.eval("void __journey.deliver({ conversation: 'dm-ines', count: 3, spacingMs: 100, text: 'backlog' })")
    page.expect_stays(f'{ORDER} === window.__held', 1200)
    page.resize(700, 800)
    quiet(page, 20)
    page.resize(1280, 800)
    quiet(page, 20)
    page.expect('__journey.state().catchingUp', 'the catch-up ended on its own')
    page.expect(f'{ORDER} === window.__held', 'the sidebar was not held')
