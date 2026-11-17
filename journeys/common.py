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


# How far the message list's end is below its view, in px.
DISTANCE = f'(() => {{ const s = document.querySelector({SCROLLER!r}); return s.scrollHeight - s.scrollTop - s.clientHeight; }})()'
# The follow slack (DECISIONS C1): half the list's visible height, at least 120 px.
SLACK = f'(() => Math.max(120, Math.round(document.querySelector({SCROLLER!r}).clientHeight / 2)))()'
AT_BOTTOM = f'{DISTANCE} < 3'


def scroll_to_distance(page, px):
    """Leaves the message list `px` short of its end, by setting its scroll position (a user's drag
    lands anywhere; the exact distance is what the boundary journeys need)."""
    page.eval(f'const s = document.querySelector({SCROLLER!r}); s.scrollTop = s.scrollHeight - s.clientHeight - {px}; return 1;')
    page.wait_for(f'Math.abs({DISTANCE} - {px}) < 3')
    page.eval('new Promise((r) => setTimeout(r, 250))')  # the list reads the position it was left at


# The message at index `from_end` counting back from the newest (0 = newest).
def is_current(from_end):
    return f"""(() => {{
      const m = [...document.querySelectorAll({MESSAGE!r})];
      const e = m[m.length - 1 - {from_end}];
      return !!e && e.hasAttribute('data-current') && document.activeElement === e;
    }})()"""


def click_text(page, selector, text):
    """Clicks the element matching `selector` whose text is `text` (marked for the click, since a selector can't say it)."""
    page.eval(
        f'for (const e of document.querySelectorAll("[data-journey-pick]")) e.removeAttribute("data-journey-pick");'
        f' const hit = [...document.querySelectorAll({selector!r})].find((e) => e.textContent.trim() === {text!r});'
        ' if (!hit) throw new Error("nothing to click"); hit.setAttribute("data-journey-pick", ""); return 1;'
    )
    page.click('[data-journey-pick]')
