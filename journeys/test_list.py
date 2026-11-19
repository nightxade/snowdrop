"""The message list's own behaviour in real layout: following new messages, settling rows, history paging."""
from common import (
    AT_BOTTOM,
    COMPACT_SETTINGS,
    COMPOSER,
    DISTANCE,
    JUMP_PILL,
    LAST_MESSAGE,
    MESSAGE,
    SCROLLER,
    SLACK,
    deliver_and_find,
    click_text,
    emit,
    fill,
    is_current,
    open_conversation,
    send,
    scroll_to_distance,
    settle,
)
from functools import partial

from harness import journey as _journey

# These journeys are about scrolling, jumps and rows that move: they run with motion on.
journey = partial(_journey, motion=True)


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
    """A chat opened at its first unread message is not pinned to the bottom while its rows settle, even when its end lies within half a page: the view stays at the divider (also when a row below grows) and the unread messages stay unread."""
    page.eval("__journey.deliver({ conversation: 'dm-ines', count: 30, text: 'while you were away' })")
    page.wait_for("__journey.state().conversations.find((c) => c.key === 'dm-ines').unread >= 30")
    open_conversation(page, 'dm-ines')
    page.wait_for('!!document.querySelector("[data-snowdrop=new-divider]")')
    page.eval('new Promise((r) => setTimeout(r, 500))')  # rows settle
    top = page.eval(f'document.querySelector({SCROLLER!r}).scrollTop')
    page.eval(GROW_NEWEST)
    page.expect_stays(f'Math.abs(document.querySelector({SCROLLER!r}).scrollTop - {top}) < 2 && {DISTANCE} > 200', 1500)
    page.expect("__journey.state().conversations.find((c) => c.key === 'dm-ines').unread >= 30", 'the unread messages were marked read unseen')


# The unread divider is in view, near the top edge of the list (it opens a little below it, not at it).
DIVIDER_NEAR_TOP = f"""(() => {{
  const d = document.querySelector('[data-snowdrop=new-divider]');
  const s = document.querySelector({SCROLLER!r});
  if (!d || !s) return false;
  const gap = d.getBoundingClientRect().top - s.getBoundingClientRect().top;
  return gap >= 0 && gap < 100;
}})()"""
INTRO = '!!document.querySelector("[data-snowdrop=conversation-intro]")'


def opened_at_the_divider_with_older_history(page, count):
    page.eval(f"__journey.deliver({{ conversation: 'dm-ines', count: {count}, text: 'while you were away' }})")
    page.wait_for(f"__journey.state().conversations.find((c) => c.key === 'dm-ines').unread >= {count}")
    open_conversation(page, 'dm-ines')
    page.wait_for('!!document.querySelector("[data-snowdrop=new-divider]")')
    page.wait_for(DIVIDER_NEAR_TOP)
    page.eval('new Promise((r) => setTimeout(r, 1500))')  # the rows settle, and any older page would have landed
    page.expect(DIVIDER_NEAR_TOP, 'the view is no longer at the unread divider')
    page.expect(f"__journey.state().conversations.find((c) => c.key === 'dm-ines').unread >= {count}", 'the unread messages were marked read unseen')
    # The reader moves the list up: the older history loads then, and the conversation's start is reachable.
    for _ in range(8):
        page.scroll(SCROLLER, -3000)
        if page.eval(INTRO):
            break
    page.expect(INTRO, 'the older history did not load once the reader scrolled up')


@journey()
def opened_at_the_unread_divider_stays_when_older_history_loads(page):
    """A chat with 70 unread messages and older history behind them opens at its divider and stays there: the divider is the first row loaded, and an older page that landed would move it (it is wherever the loaded unread run starts), so the page waits for the reader to scroll up, which then loads it."""
    opened_at_the_divider_with_older_history(page, 70)


@journey(settings=COMPACT_SETTINGS)
def opened_at_the_unread_divider_stays_with_compact_rows(page):
    """The same chat in compact density (one line per message, so every row height differs): the divider is still where the chat opened."""
    opened_at_the_divider_with_older_history(page, 70)


@journey()
def opened_at_a_short_unread_run_stays_when_older_history_loads(page):
    """With 30 unread messages the divider is not the first row, so the reader is further from the edge: the chat opens at the divider and stays there while rows settle."""
    opened_at_the_divider_with_older_history(page, 30)


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
        page.wait_for(f'{scroller}.scrollHeight > {height} + 500', 20000)
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


# ------------------------------------------------------------------ live events from the network


@journey()
def reaction_on_a_message_above_the_view_does_not_move_the_reader(page):
    """Reading older messages with the chat scrolled up, rows above the view change size (reactions, a tall edit, a delete): the message being read stays where it is."""
    open_conversation(page, 'dm-priya')
    fill(page, 'dm-priya', 60)
    page.wait_for(AT_BOTTOM)
    page.scroll(SCROLLER, -1500)
    settle(page, 600)
    reading = page.eval(f"""(() => {{
      const top = document.querySelector({SCROLLER!r}).getBoundingClientRect().top;
      return [...document.querySelectorAll({MESSAGE!r})].find((m) => m.getBoundingClientRect().top >= top).getAttribute('data-message-id');
    }})()""")
    above = page.eval(f"""(() => {{
      const ids = [...document.querySelectorAll({MESSAGE!r})].map((m) => m.getAttribute('data-message-id'));
      return ids.slice(0, ids.indexOf({reading!r})).slice(-3);
    }})()""")
    page.expect(f'{len(above)} >= 2', 'the journey needs rendered messages above the one being read')
    before = page.eval(top_of(reading))
    conversation = page.eval('__journey.conversationId("dm-priya")')
    for message in above:
        author, _, sent = message.rpartition(':')
        emit(page, 'reaction', {'conversationId': conversation, 'targetAuthorId': author, 'targetSentAt': int(sent),
                                'reaction': {'authorId': author, 'emoji': '🎉', 'at': int(sent) + 10}, 'remove': False})
        settle(page, 300)
    page.expect(f'Math.abs({top_of(reading)} - {before}) < 2', 'the message being read moved when messages above it got reactions')
    # Two changes back to back, closer together than the list's quiet period.
    for message in above[:2]:
        author, _, sent = message.rpartition(':')
        emit(page, 'reaction', {'conversationId': conversation, 'targetAuthorId': author, 'targetSentAt': int(sent),
                                'reaction': {'authorId': author, 'emoji': '👍', 'at': int(sent) + 20}, 'remove': False})
        settle(page, 30)
    settle(page, 400)
    page.expect(f'Math.abs({top_of(reading)} - {before}) < 2', 'the message being read moved when two messages above it changed in quick succession')
    first, last = above[0].rpartition(':'), above[-1].rpartition(':')
    emit(page, 'messageEdited', {'conversationId': conversation, 'authorId': first[0], 'targetSentAt': int(first[2]),
                                 'body': 'a much longer edit ' * 60, 'ranges': [], 'editedAt': int(first[2]) + 1000})
    settle(page, 300)
    page.expect(f'Math.abs({top_of(reading)} - {before}) < 2', 'the message being read moved when a message above it was edited to a tall one')
    emit(page, 'messageDeleted', {'conversationId': conversation, 'authorId': last[0], 'targetSentAt': int(last[2])})
    settle(page, 300)
    page.expect(f'Math.abs({top_of(reading)} - {before}) < 2', 'the message being read moved when a message above it was deleted')


@journey()
def late_reaction_does_not_show_on_a_deleted_message(page):
    """A message is deleted for everyone and a reaction to it arrives afterwards: the deleted message carries no reaction."""
    open_conversation(page, 'dm-priya')
    author, sent = deliver_and_find(page, 'dm-priya', 'to be deleted')
    row = f'[data-message-id="{author}:{sent}"]'
    conversation = page.eval('__journey.conversationId("dm-priya")')
    emit(page, 'messageDeleted', {'conversationId': conversation, 'authorId': author, 'targetSentAt': sent})
    page.wait_for(f'document.querySelector({row!r}).textContent.includes("was deleted")')
    emit(page, 'reaction', {'conversationId': conversation, 'targetAuthorId': author, 'targetSentAt': sent,
                            'reaction': {'authorId': author, 'emoji': '🎉', 'at': sent + 10}, 'remove': False})
    settle(page, 500)
    page.expect(f'!document.querySelector({row!r}).querySelector("[aria-label=Reactions]")', 'a reaction is shown on a deleted message')


# ------------------------------------------------------------------ marked unread and the new-messages bar (S8)

DINES = "__journey.state().conversations.find((c) => c.key === 'dm-ines')"
PRIYA = "__journey.state().conversations.find((c) => c.key === 'dm-priya')"


def mark_unread_from_its_row(page, key):
    """The chat's own sidebar row, Shift+F10, "Mark as unread" (a keyboard user's way, focus staying out of the chat)."""
    row = f'[data-snowdrop=sidebar] [data-conversation-id="{page.eval(f"__journey.conversationId({key!r})")}"]'
    page.eval(f'(document.querySelector({row!r}).focus(), 1)')
    page.wait_for(f'document.activeElement === document.querySelector({row!r})')
    page.key('F10', ['shift'])
    page.wait_for('!!document.querySelector("[role=menu]")')
    click_text(page, '[role=menu] [role=menuitem]', 'Mark as unread')
    page.wait_for('!document.querySelector("[role=menu]")')


@journey()
def marked_unread_open_chat_holds_until_the_reader_interacts(page):
    """"Mark as unread" on the chat that is open holds while messages arrive in it (they are not read for the user); the first scroll, key in the list, or typing in the chat ends it, and what arrived is read then."""
    open_conversation(page, 'dm-priya')
    settle(page, 400)
    steps = (
        ('a scroll', lambda: page.scroll(SCROLLER, 50)),
        ('a key in the list', lambda: (page.eval(f'([...document.querySelectorAll({MESSAGE!r})].at(-1).focus(), 1)'), page.key('ArrowDown'))),
        ('typing', lambda: (page.eval(f'(document.querySelector({COMPOSER!r}).focus(), 1)'), page.type('x'))),
    )
    for name, interact in steps:
        mark_unread_from_its_row(page, 'dm-priya')
        page.wait_for(f'{PRIYA}.hasUnread === true')
        page.eval("__journey.deliver({ conversation: 'dm-priya', text: 'arrives while marked unread' })")
        page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("arrives while marked unread")')
        page.expect_stays(f'{PRIYA}.hasUnread === true', 800)
        interact()
        page.wait_for(f'{PRIYA}.hasUnread === false && {PRIYA}.unread === 0', 3000)
        page.eval("new Promise((r) => setTimeout(r, 200))")


@journey()
def marked_unread_open_chat_is_cleared_by_reopening_it(page):
    """"Mark as unread" on the open chat, then the chat is left and opened again: the flag is gone."""
    open_conversation(page, 'dm-priya')
    settle(page, 400)
    mark_unread_from_its_row(page, 'dm-priya')
    page.wait_for(f'{PRIYA}.hasUnread === true')
    open_conversation(page, 'dm-ines')
    open_conversation(page, 'dm-priya')
    page.wait_for(f'{PRIYA}.hasUnread === false', 3000)


BAR = '[data-snowdrop=new-messages-bar]'


@journey()
def new_messages_bar_comes_back_for_messages_that_arrive_after_mark_as_read(page):
    """A chat opened at its 80 unread messages, scrolled past the divider: the bar says 80 new messages; "Mark as read" hides it; two more messages arrive while the reader is still scrolled up: the bar returns and says 2 (what is unread now)."""
    page.eval("__journey.deliver({ conversation: 'dm-ines', count: 80, text: 'while you were away' })")
    page.wait_for(f'{DINES}.unread >= 80')
    open_conversation(page, 'dm-ines')
    page.wait_for('!!document.querySelector("[data-snowdrop=new-divider]")')
    page.wait_for(DIVIDER_NEAR_TOP)
    settle(page, 1500)
    page.eval(f'(document.querySelector({SCROLLER!r}).scrollTop += 700, 1)')
    settle(page, 600)
    page.wait_for(f'!!document.querySelector({BAR!r})', 3000)
    page.expect(f'parseInt(document.querySelector({BAR!r}).textContent) === {DINES}.unread && {DINES}.unread >= 80', 'the bar does not count the unread messages')
    click_text(page, f'{BAR} button', 'Mark as read')
    page.wait_for(f'!document.querySelector({BAR!r}) && {DINES}.unread === 0', 3000)
    page.eval("__journey.deliver({ conversation: 'dm-ines', count: 2, text: 'after you marked it read' })")
    page.wait_for(f'{DINES}.unread === 2', 3000)
    page.wait_for(f'!!document.querySelector({BAR!r})', 3000)
    page.expect(f'document.querySelector({BAR!r}).textContent.startsWith("2 new messages")', 'the bar does not say how many are unread now')
