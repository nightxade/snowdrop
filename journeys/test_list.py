"""The message list's own behaviour in real layout: following new messages, settling rows, history paging."""
from common import (
    AT_BOTTOM,
    COMPOSER,
    DISTANCE,
    JUMP_PILL,
    LAST_MESSAGE,
    MESSAGE,
    SCROLLER,
    SLACK,
    is_current,
    open_conversation,
    send,
    scroll_to_distance,
)
from harness import journey


def top_of(message_id):
    return f'document.querySelector(\'[data-message-id="{message_id}"]\')?.getBoundingClientRect().top'


MIDDLE_MESSAGE = f"""(() => {{
  const s = document.querySelector({SCROLLER!r}).getBoundingClientRect();
  const mid = s.top + s.height / 2;
  const rows = [...document.querySelectorAll({MESSAGE!r})];
  rows.sort((a, b) => Math.abs(a.getBoundingClientRect().top - mid) - Math.abs(b.getBoundingClientRect().top - mid));
  return rows[0].getAttribute('data-message-id');
}})()"""


def open_via_switcher(page, name):
    """Ctrl+K, a name, Enter: the way to a chat that is not in the home list (it is in another space)."""
    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.type(name)
    page.key('Enter')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(f'document.querySelectorAll({MESSAGE!r}).length > 0')


def fill(page, key='dm-priya', count=40):
    """A conversation long enough to scroll."""
    page.eval(f"__journey.deliver({{ conversation: {key!r}, count: {count}, spacingMs: 20, text: 'filler' }})")
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("filler {count}")')


@journey()
def follow_boundary_is_half_a_page(page):
    """A reader 10 px inside half the list's height from the end follows a new message; 10 px outside is left where they are."""
    open_conversation(page, 'dm-priya')
    fill(page)
    slack = page.eval(SLACK)

    scroll_to_distance(page, slack - 10)
    page.eval("__journey.deliver({ conversation: 'dm-priya', text: 'just inside' })")
    page.wait_for(AT_BOTTOM)
    page.expect(f'{LAST_MESSAGE}.textContent.includes("just inside")')

    scroll_to_distance(page, slack + 10)
    anchor = page.eval(MIDDLE_MESSAGE)
    before = page.eval(top_of(anchor))
    page.eval("__journey.deliver({ conversation: 'dm-priya', text: 'just outside' })")
    page.wait_for(f'!!document.querySelector({JUMP_PILL!r})')
    page.expect_stays(f'Math.abs({top_of(anchor)} - {before}) < 2 && {DISTANCE} > {slack}', 1200)

NEWEST_IN_VIEW = f"""(() => {{
  const m = {LAST_MESSAGE};
  const s = document.querySelector({SCROLLER!r});
  if (!m || !s) return false;
  const a = m.getBoundingClientRect(), b = s.getBoundingClientRect();
  return a.top >= b.top - 2 && a.bottom <= b.bottom + 2;
}})()"""


# A row that is measured late (an image or a font arriving after it rendered): the newest one grows by 400 px.
GROW_NEWEST = f"""const m = {LAST_MESSAGE}; m.style.minHeight = (m.getBoundingClientRect().height + 400) + 'px'; return 1;"""


@journey()
def opened_at_the_bottom_stays_there(page):
    """A chat opened at its end holds the end when its newest row grows after it was measured, and when the composer grows under it: the newest message is still whole and in view."""
    open_conversation(page, 'dm-priya')
    page.wait_for(NEWEST_IN_VIEW)
    page.expect_stays(NEWEST_IN_VIEW, 600)
    page.eval(GROW_NEWEST)
    page.wait_for(f'{NEWEST_IN_VIEW} && {AT_BOTTOM}')
    page.expect_stays(f'{NEWEST_IN_VIEW} && {AT_BOTTOM}', 800)
    # The composer growing shrinks the list: it was holding the end, so it still does.
    page.click(COMPOSER)
    for _ in range(6):
        page.key('Enter', ['shift'])
    page.wait_for(f'document.querySelector({COMPOSER!r}).clientHeight > 100')
    page.wait_for(f'{NEWEST_IN_VIEW} && {AT_BOTTOM}')


@journey()
def opened_at_the_unread_divider_is_not_pulled_down(page):
    """A chat opened at its first unread message, far from the end, is not pinned to the bottom: when a row below grows the view stays where it is."""
    page.eval("__journey.deliver({ conversation: 'dm-ines', count: 30, text: 'while you were away' })")
    page.wait_for("__journey.state().conversations.find((c) => c.key === 'dm-ines').unread >= 30")
    open_conversation(page, 'dm-ines')
    page.wait_for('!!document.querySelector("[data-snowdrop=new-divider]")')
    page.eval('new Promise((r) => setTimeout(r, 500))')  # rows settle
    top = page.eval(f'document.querySelector({SCROLLER!r}).scrollTop')
    page.eval(GROW_NEWEST)
    page.expect_stays(f'Math.abs(document.querySelector({SCROLLER!r}).scrollTop - {top}) < 2 && {DISTANCE} > 200', 1500)


@journey(query='mockBulkMessages=400')
def scrolling_up_loads_older_messages_without_a_jump(page):
    """In a long chat, scrolling up to a screen or two from the top of what is loaded brings in older messages before the reader reaches it, and the message being read does not move when they arrive."""
    open_via_switcher(page, 'Engineering')
    page.wait_for(AT_BOTTOM)
    page.scroll(SCROLLER, -600)  # a real wheel to start with
    page.eval('__journey.setLoadDelay(300)')
    scroller = f'document.querySelector({SCROLLER!r})'
    for page_no in range(1, 4):
        # Near the top of what is loaded, but not at it: inside the prefetch distance, not at the wall.
        page.eval(f'const s = {scroller}; s.scrollTop = 1200; return 1;')
        page.eval('new Promise((r) => setTimeout(r, 250))')
        height = page.eval(f'{scroller}.scrollHeight')
        anchor = page.eval(MIDDLE_MESSAGE)
        before = page.eval(top_of(anchor))
        page.wait_for(f'{scroller}.scrollHeight > {height} + 500', 6000)
        page.eval('new Promise((r) => setTimeout(r, 400))')  # the new rows settle
        page.expect(f'Math.abs({top_of(anchor)} - {before}) < 3', f'page {page_no}: the message being read moved when older ones arrived')
        page.expect(f'{scroller}.scrollTop > 300', f'page {page_no}: the view was thrown to the top')


HOVER_BAR = '[data-snowdrop=hover-bar]'


def under_pointer(page):
    """JS for the message row under the pointer, which `page.hover` left at the centre of the list."""
    r = page.rect(SCROLLER)
    x, y = r['x'] + r['w'] / 2, r['y'] + r['h'] / 2
    return f'document.elementFromPoint({x}, {y})?.closest({MESSAGE!r})'


@journey()
def hover_follows_a_pointer_the_list_scrolls_under(page):
    """With the pointer still, rows scroll under it, even far enough for the hovered row to leave the page: one row shows the hover bar at a time, the one under the pointer, and the old one is not still hovered when it comes back."""
    open_conversation(page, 'dm-priya')
    fill(page)
    page.hover(SCROLLER)  # the centre of the list: some row is under it
    row = under_pointer(page)
    one_bar = f'document.querySelectorAll({HOVER_BAR!r}).length === 1 && {row}?.querySelector({HOVER_BAR!r}) !== null'
    page.wait_for(one_bar)
    scroller = f'document.querySelector({SCROLLER!r})'
    page.scroll(SCROLLER, -250)
    page.wait_for(one_bar, 3000)
    first = page.eval(f'{row}.getAttribute("data-message-id")')
    page.expect_stays(f'document.querySelectorAll({HOVER_BAR!r}).length === 1 && document.querySelectorAll("[data-message-active]").length === 1', 300)
    # The hovered row is carried out of the rendered range, then back, the pointer still where it was.
    page.eval(f'const s = {scroller}; window.__top = s.scrollTop; s.scrollTop = s.scrollTop - 2500; return 1;')
    page.wait_for(f'!document.querySelector(\'[data-message-id="{first}"]\')', 3000)
    page.wait_for(one_bar, 3000)
    page.eval(f'const s = {scroller}; s.scrollTop = window.__top + 70; return 1;')
    page.wait_for(f'!!document.querySelector(\'[data-message-id="{first}"]\')', 3000)
    page.wait_for(one_bar, 3000)
    page.expect_stays(f'{one_bar} && document.querySelectorAll("[data-message-active]").length === 1', 400)


def reply_to_current(page, text):
    """With a message current: R, the reply, Enter, and wait for it to be sent."""
    page.key('r')
    page.wait_for('!!document.querySelector("[data-snowdrop=reply-bar]")')
    page.type(text)
    page.key('Enter')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes({text!r}) && !{LAST_MESSAGE}.hasAttribute("data-pending")')


@journey()
def one_row_flashes_after_a_jump(page):
    """Clicking a quote flashes the message it quotes; clicking another quote while that one still flashes moves the flash: never two rows flashing."""
    open_conversation(page, 'dm-priya')
    send(page, 'alpha')
    send(page, 'bravo')
    page.key('Escape')
    page.wait_for(is_current(0))
    page.key('ArrowUp')  # alpha
    page.wait_for(is_current(1))
    reply_to_current(page, 'to alpha')
    page.key('Escape')
    page.wait_for(is_current(2))  # still the message replied to, where the user left the marker
    page.key('ArrowDown')  # bravo
    page.wait_for(is_current(1))
    reply_to_current(page, 'to bravo')
    ids = page.eval(f'[...document.querySelectorAll({MESSAGE!r})].slice(-4).map((e) => e.getAttribute("data-message-id"))')
    alpha, bravo, to_alpha, to_bravo = ids
    flashing = '[...document.querySelectorAll("[data-flash]")].map((e) => e.getAttribute("data-message-id"))'
    page.click(f'[data-message-id="{to_bravo}"] [data-snowdrop=message-quote] button')
    page.wait_for(f'{flashing}.includes({bravo!r})')
    page.click(f'[data-message-id="{to_alpha}"] [data-snowdrop=message-quote] button')  # inside the first flash's 1.6 s
    page.wait_for(f'{flashing}.includes({alpha!r})')
    page.expect_stays(f'{flashing}.length <= 1', 1000)
    page.expect(f'{flashing}.length === 1 && {flashing}[0] === {alpha!r}', 'the flash did not move to the message quoted last')


def body_of(text):
    """JS for the message body that reads exactly `text`."""
    return (
        f'[...document.querySelectorAll({MESSAGE!r} + " [data-snowdrop=message-body]")]'
        f'.find((b) => b.textContent.trim() === {text!r})'
    )


FONT_PX = 'parseFloat(getComputedStyle(%s).fontSize)'


@journey()
def jumbo_emoji_are_shown_large(page):
    """A message of just emoji is shown large, at least twice the size of a plain line."""
    open_conversation(page, 'dm-priya')
    for text in ('😀🎉', 'a plain line'):
        page.eval(f"__journey.deliver({{ conversation: 'dm-priya', exact: true, text: {text!r} }})")
    page.wait_for(f'!!{body_of("a plain line")}')
    page.expect(f'{FONT_PX % body_of("😀🎉")} > 2 * {FONT_PX % body_of("a plain line")}', 'an emoji-only message is not shown large')


@journey()
def jumbo_exceptions_and_inline_custom_emoji(page):
    """A heart with its emoji selector is large, a message of digits or plain text is not, and a custom emoji in a sentence flows inline at the size of the text."""
    open_conversation(page, 'dm-priya')
    for text in ('\u2764\ufe0f', '2024', 'a plain line'):
        page.eval(f"__journey.deliver({{ conversation: 'dm-priya', exact: true, text: {text!r} }})")
    page.eval("__journey.deliver({ conversation: 'dm-priya', customEmoji: true, text: 'party time :partyblob: again' })")
    plain = FONT_PX % body_of('a plain line')
    page.wait_for(f'!!{body_of("a plain line")} && {LAST_MESSAGE}?.textContent.includes("again")')
    page.expect(f'{FONT_PX % body_of(chr(0x2764) + chr(0xfe0f))} > 2 * {plain}', 'an emoji with the selector is not shown large')
    page.expect(f'{FONT_PX % body_of("2024")} === {plain}', 'digits alone are shown large')
    inline = f'{LAST_MESSAGE}.querySelector("[data-snowdrop=message-body]")'
    page.wait_for(f'!!{inline}.querySelector("img")')
    page.expect(
        f'(() => {{ const b = {inline}, i = b.querySelector("img"); const ib = i.getBoundingClientRect(), bb = b.getBoundingClientRect();'
        f' const px = parseFloat(getComputedStyle(b).fontSize); const lines = bb.height / parseFloat(getComputedStyle(b).lineHeight);'
        ' return getComputedStyle(i.parentElement).display.startsWith("inline") && ib.height > px && ib.height < 1.5 * px && lines < 1.5 && ib.top >= bb.top - 1 && ib.bottom <= bb.bottom + 1; })()',
        'the custom emoji does not sit in the line of text',
    )


COLOR_OF_TOKEN = """(token) => { const p = document.createElement('span'); p.style.color = `var(${token})`;
  document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; }"""


@journey()
def pending_message_is_muted_with_a_clock(page):
    """While a message is still sending its text is muted (not faded) and it carries a clock; once sent it reads like any other message."""
    open_conversation(page, 'dm-priya')
    page.eval('__journey.setSendDelay(2500)')
    page.click(COMPOSER)
    page.type('on its way')
    page.key('Enter')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("on its way") && {LAST_MESSAGE}.hasAttribute("data-pending")')
    body = f'{LAST_MESSAGE}.querySelector("[data-snowdrop=message-body]")'
    color = f'getComputedStyle({body}).color'
    token = f'({COLOR_OF_TOKEN})'
    page.expect(f'{color} === {token}("--snowdrop-text-muted")', 'the pending text is not in the muted colour')
    page.expect(f'getComputedStyle({LAST_MESSAGE}).opacity === "1" && getComputedStyle({body}).opacity === "1"', 'a pending message is faded')
    page.expect(f'!!{LAST_MESSAGE}.querySelector(\'[class*="_pendingMark_"] svg\') && {LAST_MESSAGE}.textContent.includes("Sending")', 'a pending message has no "Sending" clock')
    page.wait_for(f'!{LAST_MESSAGE}.hasAttribute("data-pending")', 6000)
    page.expect(f'{color} === {token}("--snowdrop-text") && !{LAST_MESSAGE}.querySelector(\'[class*="_pendingMark_"]\')', 'the sent message still looks pending')
