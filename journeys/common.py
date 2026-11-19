"""Steps and selectors shared by the journeys."""
import json

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


# ---------------------------------------------------------------- modes

# Stored settings a user would have chosen before the session (`journey(settings=...)`, or the walk's mode).
VIM_SETTINGS = {'plugins': {'vim-mode': {'enabled': True, 'settings': {'introShown': True}}}}
# Vim mode with the setting that would put every opened chat's focus in the composer (Vim must ignore it).
VIM_WITH_COMPOSER_ON_OPEN = {**VIM_SETTINGS, 'behaviour': {'focusComposerOnOpen': True}}
TUI_SETTINGS = {'appearance': {'shell': 'tui'}}
COMPACT_SETTINGS = {'appearance': {'density': 'compact'}}
OTHER_THEME_SETTINGS = {'appearance': {'themeId': 'linen'}}

# Focus is on the message list: a message row, or the list's own scroller (never the composer or a row of the sidebar).
ON_LIST = 'document.activeElement?.matches("[data-snowdrop=message], [data-virtuoso-scroller]") === true'
IN_COMPOSER = f'document.activeElement === document.querySelector({COMPOSER!r})'
ON_SIDEBAR_ROW = 'document.activeElement?.matches("[data-snowdrop=sidebar] [data-conversation-id]") === true'


def settle(page, ms):
    """Lets the page run for `ms` (a late focus move, a debounce, a blink)."""
    page.eval(f'new Promise((r) => setTimeout(r, {int(ms)}))')


def quiet(page, frames=8):
    """Waits for the page to stop moving: every animation and transition finished, then `frames` painted
    frames (layout observers, a virtualised list's re-measure and a debounce of a frame or two have run).
    Use it in place of `settle` where the thing being waited for is the page catching up with a change."""
    page.eval(
        'const running = document.getAnimations(); await Promise.all(running.map((a) => a.finished.catch(() => 0)));'
        f' for (let i = 0; i < {int(frames)}; i++) await new Promise((r) => requestAnimationFrame(r)); return 1;'
    )


def colour_of(css):
    """JS: the computed `rgb()` text of any CSS colour (a `var(--...)` too), as the page paints it."""
    return (
        f'(() => {{ const p = document.createElement("span"); p.style.color = {css!r}; document.body.appendChild(p);'
        ' const c = getComputedStyle(p).color; p.remove(); return c; })()'
    )


def select_space(page, name):
    """Clicks a space's tile in the rail (its label starts with the name)."""
    click_text_starting(page, '[data-snowdrop=rail] button', name)


def click_text_starting(page, selector, prefix):
    page.eval(
        f'for (const e of document.querySelectorAll("[data-journey-pick]")) e.removeAttribute("data-journey-pick");'
        f' const hit = [...document.querySelectorAll({selector!r})].find((e) => (e.getAttribute("aria-label") || e.textContent).trim().startsWith({prefix!r}));'
        ' if (!hit) throw new Error("nothing to click"); hit.setAttribute("data-journey-pick", ""); return 1;'
    )
    page.click('[data-journey-pick]')


MODE_PILL = '[data-snowdrop=vim-mode]'
VIM_CARET = '[data-snowdrop=vim-caret]'


def fill(page, key='dm-priya', count=40):
    """A conversation long enough to scroll."""
    # Not awaited inside the script (its 10 s limit would count a slow machine's timers against the journey):
    # the wait below polls for the last message instead.
    page.eval(f"return (void __journey.deliver({{ conversation: {key!r}, count: {count}, spacingMs: 20, text: 'filler' }}), 1)")
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("filler {count}")', 30000)


# ---------------------------------------------------------------- live events from the network

def emit(page, event, payload):
    """Plays a backend event as if it came from the network (`__journey.emit`): an edit, a delete, a reaction, a request answered on the phone."""
    page.eval(f'return (__journey.emit({event!r}, {json.dumps(payload)}), 1)')


def deliver_and_find(page, key, text):
    """A message from the other person arrives in the open chat; returns its (author id, sent time)."""
    page.eval(f'__journey.deliver({{ conversation: {key!r}, count: 1, text: {text!r}, exact: true }})')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes({text!r})')
    author, _, sent = page.eval(f'{LAST_MESSAGE}.getAttribute("data-message-id")').rpartition(':')
    return author, int(sent)


def forget_expected_send_failures(page):
    """A journey that makes a send fail on purpose: the app logs it with `console.error`, which would fail the run."""
    page.eval(
        'const keep = window.__errors.filter((e) => !e.includes("[send] send failed"));'
        ' window.__errors.length = 0; window.__errors.push(...keep); return 1'
    )


# ---------------------------------------------------------------- menus

def open_menu(page, selector):
    """Focuses the element and opens its context menu from the keyboard (Shift+F10)."""
    page.eval(f'(document.querySelector({selector!r}).focus(), 1)')
    page.key('F10', ['shift'])
    page.wait_for('!!document.querySelector("[role=menu]")')


def click_menu_item(page, text):
    """Clicks the open menu's item whose text contains `text` (a space's item starts with its emoji)."""
    page.eval(
        'for (const e of document.querySelectorAll("[data-journey-pick]")) e.removeAttribute("data-journey-pick");'
        f' const hit = [...document.querySelectorAll("[role^=menuitem]")].find((e) => e.textContent.trim().includes({text!r}));'
        ' if (!hit) throw new Error("no such menu item"); hit.setAttribute("data-journey-pick", ""); return 1;'
    )
    page.click('[data-journey-pick]')
