"""Vim mode (DECISIONS M11-M13): where focus lands and the composer's modes, in real WebKitGTK."""
from common import (
    COMPOSER,
    IN_COMPOSER,
    LAST_MESSAGE,
    MESSAGE,
    MODE_PILL,
    ON_LIST,
    TUI_SETTINGS,
    VIM_CARET,
    VIM_SETTINGS,
    VIM_WITH_COMPOSER_ON_OPEN,
    colour_of,
    open_conversation,
    select_space,
    settle,
)
from harness import journey

BODY_FOCUSED = 'document.activeElement === document.body'
SEARCH_FIELD = '[data-snowdrop=search-panel] input'


SPACE = 'document.querySelector("[data-snowdrop=rail] [aria-current=page]")?.getAttribute("aria-label")'


def lands_on_the_list(page):
    """Focus reaches the message list, and in the next 600 ms is never in the composer (a late move there would be the bug)."""
    page.wait_for(ON_LIST, 3000)
    for _ in range(15):
        page.expect(f'!({IN_COMPOSER})', 'focus moved into the composer')
        settle(page, 40)
    page.wait_for(ON_LIST, 3000)


def opened(key):
    return f'__journey.state().selected === __journey.conversationId({key!r})'


def row(page, key):
    return f'[data-conversation-id="{page.eval(f"__journey.conversationId({key!r})")}"]'


def selected(page):
    return page.eval('__journey.state().selected')


# ------------------------------------------------------------------ M11


@journey(settings=VIM_WITH_COMPOSER_ON_OPEN, notifications=True)
def vim_every_open_path_lands_on_the_list(page):
    """Vim mode on, with "focus the message box on open" also on: a sidebar click made from the composer, J, K, ]u, gT back to a space, the quick switcher and a clicked notification all leave focus on the message list, never the composer."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.wait_for(IN_COMPOSER)
    page.click(row(page, 'dm-rafferty'))
    page.wait_for(opened('dm-rafferty'))
    lands_on_the_list(page)

    page.key('J')
    page.wait_for('!(' + opened('dm-rafferty') + ')')
    lands_on_the_list(page)
    page.key('K')
    page.wait_for(opened('dm-rafferty'))
    lands_on_the_list(page)

    before = selected(page)
    page.eval("__journey.deliver({ conversation: 'dm-ines', text: 'unread for the next-unread key' })")
    page.wait_for("__journey.state().conversations.find((c) => c.key === 'dm-ines').unread > 0")
    page.key(']')
    page.key('u')
    page.wait_for(f'__journey.state().selected !== {before!r}')
    lands_on_the_list(page)

    # gt goes to the next space, and gT back: the chat still open there gets the list, not the composer.
    space = page.eval(SPACE)
    page.key('g')
    page.key('t')
    page.wait_for(f'{SPACE} !== {space!r}')
    page.expect_stays(f'!({IN_COMPOSER})', 400)
    page.key('g')
    page.key('T', ['shift'])
    page.wait_for(f'{SPACE} === {space!r}')
    lands_on_the_list(page)

    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.type('priy')
    page.key('Enter')
    page.wait_for(opened('dm-priya'))
    page.wait_for('!document.querySelector("[role=dialog]")')
    lands_on_the_list(page)

    # A notification for another chat, clicked: the app opens that chat and the list gets focus.
    page.eval("__journey.deliver({ conversation: 'dm-oren', text: 'a message to click' })")
    page.wait_for('window.__notified.some((n) => n.body.includes("a message to click"))')
    page.click_notification(-1)
    page.wait_for(opened('dm-oren'))
    lands_on_the_list(page)


# ------------------------------------------------------------------ M12


def focus_then_escape(page, selector, what):
    """Puts focus on a control the way Tab would, then presses a real Esc."""
    page.eval(f'(document.querySelector({selector!r}).focus(), true)')
    page.wait_for(f'document.activeElement === document.querySelector({selector!r})')
    page.key('Escape')
    page.wait_for(ON_LIST, 3000)


@journey(settings=VIM_SETTINGS)
def vim_escape_returns_to_the_list(page):
    """Vim mode on: Esc from a sidebar row, a rail tile, a header button, the search panel (Esc closes it) and the composer (Insert, then Normal) ends on the message list; with no chat open it blurs."""
    # No chat open: Esc from a sidebar row blurs to the page.
    page.eval('(document.querySelector("[data-snowdrop=sidebar] [data-conversation-id]").focus(), true)')
    page.wait_for('!!document.activeElement.closest("[data-snowdrop=sidebar]")')
    page.key('Escape')
    page.wait_for(BODY_FOCUSED, 3000)

    open_conversation(page, 'dm-priya')
    lands_on_the_list(page)
    sidebar_row = row(page, 'dm-priya')
    focus_then_escape(page, f'[data-snowdrop=sidebar] {sidebar_row}', 'a sidebar row')
    focus_then_escape(page, '[data-snowdrop=rail] button', 'a rail tile')
    focus_then_escape(page, '[data-snowdrop=chat-header] button', 'a header button')
    page.expect_stays(ON_LIST, 400)

    # The chat's search panel owns Esc: it closes the panel (with text in the field too, empty or not) and ends on the list.
    for typed in ('abc', ''):
        page.key('/')
        page.wait_for(f'document.activeElement === document.querySelector({SEARCH_FIELD!r})')
        if typed:
            page.type(typed)
        page.key('Escape')
        page.wait_for(f'!document.querySelector({SEARCH_FIELD!r})')
        page.wait_for(ON_LIST, 3000)

    # The composer: the first Esc leaves Insert for Normal and keeps focus; Esc again on an empty draft returns to the list.
    page.click(COMPOSER)
    page.wait_for(IN_COMPOSER)
    page.key('Escape')
    page.wait_for(f'document.querySelector({MODE_PILL!r}).getAttribute("data-vim-mode") === "normal"')
    page.expect_stays(IN_COMPOSER, 300)
    page.key('Escape')
    page.wait_for(ON_LIST, 3000)
    page.expect_stays(f'!({IN_COMPOSER})', 400)


# ------------------------------------------------------------------ M13

MODE = f'document.querySelector({MODE_PILL!r})?.getAttribute("data-vim-mode")'
CARET_BOX = f"""(() => {{
  const c = document.querySelector({VIM_CARET!r}), f = document.querySelector({COMPOSER!r});
  if (!c || !f) return null;
  const a = c.getBoundingClientRect(), b = f.getBoundingClientRect();
  return a.width > 2 && a.height > 8 && a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
}})()"""


def caret_fill(page):
    """The painted colour at the caret's bottom-left corner, which the drawn letter does not reach."""
    box = page.rect(VIM_CARET)
    return page.pixel(box['x'] + 1.5, box['y'] + box['h'] - 2)


def accent_rgb(page):
    """The accent as (r, g, b)."""
    text = page.eval(colour_of('var(--snowdrop-accent)'))
    return tuple(int(part) for part in text[text.index('(') + 1 : text.index(')')].split(',')[:3])


@journey(settings=VIM_SETTINGS)
def vim_composer_modes_and_caret(page):
    """Vim mode: the composer starts in Insert (no block, mode pill INSERT); Esc gives Normal with an accent block inside the field, really painted; v gives Visual; unfocused the block is hollow; i is back to Insert with no block."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.wait_for(IN_COMPOSER)
    page.expect(f'{MODE} === "insert" && !document.querySelector({VIM_CARET!r})')
    page.type('hello')
    page.key('Escape')
    page.wait_for(f'{MODE} === "normal"')
    page.wait_for(CARET_BOX, 3000)
    page.expect(f'document.querySelector({VIM_CARET!r}).getAttribute("data-focused") === "true"')
    page.expect(f'getComputedStyle(document.querySelector({VIM_CARET!r})).backgroundColor === {colour_of("var(--snowdrop-accent)")}')

    # The paint, not just the style: the block blinks, so some frame in a few seconds shows the accent under it.
    accent = accent_rgb(page)
    painted = []

    def accent_is_painted():
        painted.append(caret_fill(page))
        return painted[-1] == accent

    page.wait_for('true')
    for _ in range(40):
        if accent_is_painted():
            break
        settle(page, 100)
    else:
        raise AssertionError(f'the block never painted the accent {accent}: saw {sorted(set(painted))[:4]}')

    page.key('v')
    page.wait_for(f'{MODE} === "visual"')
    page.wait_for(CARET_BOX)
    page.key('Escape')
    page.wait_for(f'{MODE} === "normal"')

    # Unfocused (focus on a message): a hollow outline, not a solid block.
    page.click(MESSAGE)
    page.wait_for(f'document.querySelector({VIM_CARET!r})?.getAttribute("data-focused") === "false"')
    page.expect(f'getComputedStyle(document.querySelector({VIM_CARET!r})).backgroundColor === "rgba(0, 0, 0, 0)"')
    page.expect(f'getComputedStyle(document.querySelector({VIM_CARET!r})).boxShadow !== "none"')

    page.click(COMPOSER)
    page.wait_for(IN_COMPOSER)
    page.key('i')
    page.wait_for(f'{MODE} === "insert"')
    page.expect(f'!document.querySelector({VIM_CARET!r})')


@journey(settings={**VIM_SETTINGS, **TUI_SETTINGS})
def vim_mode_shows_on_the_tui_status_line(page):
    """Vim mode in the TUI shell: the status line says INSERT in a fresh composer and NORMAL after Esc."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.wait_for(IN_COMPOSER)
    status = 'document.querySelector("[data-snowdrop=status-line]").textContent'
    page.wait_for(f'{status}.includes("INSERT")')
    page.key('Escape')
    page.wait_for(f'{status}.includes("NORMAL") && !{status}.includes("INSERT")')


# ------------------------------------------------------------------ Vim with other keys and modes

RECORDER = '[aria-label="Voice message recorder"]'
EDITOR = '[data-snowdrop=message] textarea'


@journey(
    settings=VIM_SETTINGS,
)
def vim_escape_cancels_a_voice_recording(page):
    """Vim mode on, a voice message started with Mod+Shift+Y: one Esc cancels it, as without Vim mode."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('y', ['ctrl', 'shift'])
    page.wait_for(f'!!document.querySelector({RECORDER!r})')
    page.key('Escape')
    settle(page, 500)
    page.expect(f'!document.querySelector({RECORDER!r})', 'Esc did not cancel the recording')
    page.expect(f'document.activeElement === document.querySelector({COMPOSER!r})', 'focus did not return to the composer')


@journey(
    settings=VIM_SETTINGS,
)
def vim_escape_in_an_emptied_message_editor_cancels_the_edit(page):
    """Vim mode on, editing your own message and clearing its text: Esc cancels the edit (the editor closes), it does not leave an editor open with focus elsewhere."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.type('to be edited')
    page.key('Enter')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("to be edited") && !{LAST_MESSAGE}.hasAttribute("data-pending")')
    page.key('Escape')
    page.key('Escape')
    page.wait_for(ON_LIST)
    page.key('e')
    page.wait_for(f'!!document.querySelector({EDITOR!r})')
    page.key('a', ['ctrl'])
    page.key('BackSpace')
    page.expect(f'document.querySelector({EDITOR!r}).value === ""')
    page.key('Escape')
    settle(page, 500)
    page.expect(f'!document.querySelector({EDITOR!r})', 'the edit was not cancelled')


MODAL_EDITING_ONLY = {'plugins': {'vim-mode': {'enabled': True, 'settings': {'introShown': True, 'navigation': False}}}}


@journey(
    settings=MODAL_EDITING_ONLY,
)
def vim_modal_editing_alone_keeps_the_draft_when_typing_from_the_list(page):
    """Vim mode with navigation keys off: a draft left in Normal mode, focus on a message, a letter typed: the letter goes in at the end of the draft (Insert mode), no character of the draft is replaced."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.type('abc')
    page.key('Escape')
    page.wait_for(f'document.querySelector({MODE_PILL!r}).getAttribute("data-vim-mode") === "normal"')
    page.eval(f'({LAST_MESSAGE}.focus(), true)')
    page.wait_for(ON_LIST)
    page.type('z')
    settle(page, 300)
    page.expect(f'document.querySelector({COMPOSER!r}).value === "abcz"', 'a typed letter overwrote the draft')
    page.expect(f'document.querySelector({MODE_PILL!r}).getAttribute("data-vim-mode") === "insert"', 'the composer is not in Insert mode')


def enter_and_shift_enter_in_normal_mode(page):
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.type('hello')
    page.key('Escape')
    page.wait_for(f'document.querySelector({MODE_PILL!r}).getAttribute("data-vim-mode") === "normal"')
    count = page.eval(f'document.querySelectorAll({MESSAGE!r}).length')
    page.key('Enter', ['shift'])
    settle(page, 500)
    page.expect(f'document.querySelector({COMPOSER!r}).value === "hell\\no"', 'Shift+Enter did not make a new line in Normal mode')
    page.expect(f'document.querySelectorAll({MESSAGE!r}).length === {count}', 'Shift+Enter sent the draft')
    page.expect(f'document.querySelector({MODE_PILL!r}).getAttribute("data-vim-mode") === "normal"', 'the mode changed')
    page.key('Enter')
    page.wait_for(f'document.querySelector({COMPOSER!r}).value === ""')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("hell") && {LAST_MESSAGE}.textContent.includes("o")')
    page.expect(f'document.querySelectorAll({MESSAGE!r}).length === {count + 1}', 'Enter did not send the draft')


@journey(settings=VIM_SETTINGS)
def vim_normal_mode_enter_sends_and_shift_enter_makes_a_new_line(page):
    """Vim mode, default send key: in Normal mode Shift+Enter puts a new line in the draft (nothing sent, still Normal) and Enter sends it."""
    enter_and_shift_enter_in_normal_mode(page)


@journey(settings={**VIM_SETTINGS, 'behaviour': {'enterToSend': False}})
def vim_normal_mode_enter_sends_whatever_the_send_key_setting(page):
    """Vim mode with "Send with: Shift+Enter": Normal mode is the same, Enter sends and Shift+Enter makes a new line (M13)."""
    enter_and_shift_enter_in_normal_mode(page)


@journey(settings=VIM_SETTINGS)
def vim_edit_ends_on_the_message_list(page):
    """Vim mode with its navigation keys on: saving an edit with Enter, and cancelling one with Esc, leave focus on the message list, never in the composer (M11)."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.type('to be edited')
    page.key('Enter')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("to be edited") && !{LAST_MESSAGE}.hasAttribute("data-pending")')
    page.key('Escape')
    page.key('Escape')
    page.wait_for(ON_LIST)
    for ending in ('Enter', 'Escape'):
        page.key('e')
        page.wait_for(f'!!document.querySelector({EDITOR!r})')
        page.type(' x')
        page.key(ending)
        page.wait_for(f'!document.querySelector({EDITOR!r})')
        lands_on_the_list(page)


@journey(settings=VIM_SETTINGS)
def vim_search_close_button_lands_on_the_list(page):
    """Vim navigation keys on: the search panel's close button leaves focus on the message list, never the composer (M11)."""
    open_conversation(page, 'dm-priya')
    lands_on_the_list(page)
    page.key('/')
    page.wait_for(f'document.activeElement === document.querySelector({SEARCH_FIELD!r})')
    page.click('[data-snowdrop=search-panel] button[aria-label^="Close search"]')
    page.wait_for(f'!document.querySelector({SEARCH_FIELD!r})')
    lands_on_the_list(page)


@journey(settings=VIM_SETTINGS)
def vim_dd_lands_on_the_list_after_deleting_the_newest_message(page):
    """Vim navigation keys on: dd on the newest message and Enter on the question delete it, and focus ends on the message list (the message before it), never the composer (M11)."""
    open_conversation(page, 'dm-priya')
    lands_on_the_list(page)
    newest = page.eval(f'{LAST_MESSAGE}.getAttribute("data-message-id")')
    page.key('d')
    page.key('d')
    page.wait_for('!!document.querySelector("[role=alertdialog], [role=dialog]")')
    page.key('Enter')
    page.wait_for(f'!document.querySelector(\'[data-message-id="{newest}"]\') || document.querySelector(\'[data-message-id="{newest}"]\').textContent.includes("deleted")', 3000)
    page.wait_for('!document.querySelector("[role=alertdialog], [role=dialog]")')
    lands_on_the_list(page)
    settle(page, 400)
    page.expect(ON_LIST, 'focus left the message list')
