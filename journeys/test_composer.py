"""The composer's buttons (DECISIONS P2) and voice notes as far as a runner with no microphone can take them (P13)."""
from common import COMPOSER, IN_COMPOSER, LAST_MESSAGE, TUI_SETTINGS, is_current, open_conversation, settle
from harness import journey

FIELD = f'{COMPOSER}'
BUTTONS = ('Stickers', 'Emoji', 'More options')
MORE = '[data-snowdrop=composer] button[aria-label="More options"]'
RECORDER = '[aria-label="Voice message recorder"]'
ALERT = '[data-snowdrop=composer] [role=alert]'

# Where the field and the three buttons are drawn: left to right, in one row, nothing left of the field.
LAYOUT = f"""(() => {{
  const box = (e) => e.getBoundingClientRect();
  const field = box(document.querySelector({FIELD!r}));
  const at = (name) => box(document.querySelector('[data-snowdrop=composer] button[aria-label="' + name + '"]'));
  const [s, e, m] = {list(BUTTONS)!r}.map(at);
  const row = (b) => b.top < field.bottom && b.bottom > field.top;
  const all = [...document.querySelectorAll('[data-snowdrop=composer] button')].map(box);
  return field.right <= s.left + 1 && s.right <= e.left + 1 && e.right <= m.left + 1
    && [s, e, m].every(row) && all.every((b) => b.left >= field.right - 1);
}})()"""


def menu_items(page):
    """The labels of the open "More options" menu, top to bottom."""
    page.wait_for('!!document.querySelector("[role=menuitem]")')
    return page.eval(
        '[...document.querySelectorAll("[role=menuitem]")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)'
        '.map((e) => e.textContent.replace(/Ctrl\\+Shift\\+Y$/, "").trim())'
    )


def closed_menu(page):
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=menuitem]")')


def check_buttons(page):
    open_conversation(page, 'allotment')  # a group
    page.expect(LAYOUT, 'the group composer is not [field] [Stickers] [Emoji] [More options] from left to right')
    page.click(MORE)
    assert menu_items(page) == ['Upload a file', 'Poll', 'Voice message'], 'group menu order'
    closed_menu(page)

    open_conversation(page, 'dm-priya')
    page.expect(LAYOUT, 'the direct-chat composer is not [field] [Stickers] [Emoji] [More options] from left to right')
    page.click(MORE)
    assert menu_items(page) == ['Upload a file', 'Voice message'], 'direct chat menu order (no poll)'
    closed_menu(page)

    page.click(COMPOSER)
    page.wait_for(IN_COMPOSER)
    page.type('a draft')
    page.click(MORE)
    assert menu_items(page) == ['Upload a file'], 'a draft is waiting: no voice message'
    closed_menu(page)
    page.expect(LAYOUT, 'the composer with a draft is out of order')


@journey()
def composer_buttons_sit_right_of_the_field(page):
    """Standard shell, by bounding boxes: the field, then Stickers, Emoji and More options left to right in the field's row, nothing left of the field; the More options menu lists Upload, Poll (groups only), Voice message (an empty draft only)."""
    check_buttons(page)


@journey(settings=TUI_SETTINGS)
def composer_buttons_sit_right_of_the_field_in_tui(page):
    """The same order in the TUI shell, where CSS order (not the markup) places the buttons."""
    check_buttons(page)


# ------------------------------------------------------------------ P13


@journey()
def voice_message_waits_for_the_permission_and_cancels(page):
    """With the microphone permission unanswered (this webview never answers it), the voice message item shows its shortcut, starts the recorder bar in its "starting" state with Send off, Esc cancels it, and the composer is usable again."""
    open_conversation(page, 'dm-priya')
    page.click(MORE)
    page.wait_for('!!document.querySelector("[role=menuitem]")')
    page.expect('[...document.querySelectorAll("[role=menuitem]")].some((e) => e.textContent.includes("Voice message") && e.textContent.includes("Ctrl+Shift+Y"))')
    page.eval('(([...document.querySelectorAll("[role=menuitem]")].find((e) => e.textContent.startsWith("Voice message"))).setAttribute("data-journey-pick", ""), true)')
    page.click('[data-journey-pick]')
    page.wait_for(f'document.querySelector({RECORDER!r})?.getAttribute("aria-busy") === "true"')
    page.expect('document.querySelector("[aria-label=\\"Send voice message\\"]").disabled', 'Send is on before recording began')
    page.expect_stays(f'!!document.querySelector({RECORDER!r}) && !document.querySelector({ALERT!r})', 800)
    page.key('Escape')
    page.wait_for(f'!document.querySelector({RECORDER!r})')
    settle(page, 300)
    page.expect(f'!document.querySelector({ALERT!r}) && !!document.querySelector({COMPOSER!r}) && !document.querySelector({RECORDER!r})')
    # Back to normal: typing works and the menu offers the voice message again once the draft is empty.
    page.click(COMPOSER)
    page.type('x')
    page.key('BackSpace')
    page.click(MORE)
    assert 'Voice message' in menu_items(page)
    closed_menu(page)


@journey(microphone='denied')
def voice_message_refused_microphone_says_so(page):
    """The microphone refused (the permission denied): the shortcut, and the menu item after it, each end with the app's "can't use the microphone" message in the composer and no recorder bar left behind; nothing is sent."""
    open_conversation(page, 'dm-priya')
    newest = page.eval(f'{LAST_MESSAGE}.getAttribute("data-message-id")')
    page.key('y', ['ctrl', 'shift'])
    page.wait_for(f'document.querySelector({ALERT!r})?.textContent.includes("use the microphone")')
    page.expect_stays(f'!document.querySelector({RECORDER!r})', 500)

    page.click(MORE)
    page.wait_for('!!document.querySelector("[role=menuitem]")')
    page.eval('(([...document.querySelectorAll("[role=menuitem]")].find((e) => e.textContent.startsWith("Voice message"))).setAttribute("data-journey-pick", ""), true)')
    page.click('[data-journey-pick]')
    settle(page, 500)
    page.expect(f'document.querySelector({ALERT!r})?.textContent.includes("use the microphone") && !document.querySelector({RECORDER!r})')
    page.expect(f'{LAST_MESSAGE}.getAttribute("data-message-id") === {newest!r}', 'something was sent')


@journey()
def esc_on_the_cancel_reply_button_cancels_the_reply(page):
    """R opens a reply bar; Shift+Tab from the composer lands on its "Cancel reply (Esc)" button: Esc there cancels the reply, as the button says."""
    open_conversation(page, 'dm-priya')
    page.eval('__journey.deliver({ conversation: "dm-priya", count: 1, text: "incoming" })')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("incoming")')
    page.click(COMPOSER)
    page.key('Escape')
    page.wait_for(is_current(0))
    page.key('r')
    page.wait_for('!!document.querySelector("[data-snowdrop=reply-bar]")')
    page.key('Tab', ['shift'])
    page.wait_for('document.activeElement?.getAttribute("aria-label") === "Cancel reply (Esc)"')
    page.key('Escape')
    page.wait_for('!document.querySelector("[data-snowdrop=reply-bar]")', 1500)


# ------------------------------------------------------------------ known bugs found by exploring

LISTBOX = '!!document.querySelector("[role=listbox]")'


def last_message_selector(page):
    return '[data-message-id="%s"]' % page.eval(f'{LAST_MESSAGE}.getAttribute("data-message-id")')


@journey()
def reply_bar_goes_when_its_message_is_deleted(page):
    """Reply to a message, delete that message for yourself, then write the reply: the bar must not go on replying to a message that is no longer there."""
    open_conversation(page, 'dm-priya')
    page.eval('__journey.deliver({ conversation: "dm-priya", count: 1, text: "the original", exact: true })')
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("the original")')
    row = last_message_selector(page)
    page.click(row)
    page.key('r')
    page.wait_for('!!document.querySelector("[data-snowdrop=reply-bar]")')
    page.click(row)
    page.key('Delete')
    page.wait_for('!!document.querySelector("[role=alertdialog], [role=dialog]")')
    page.key('Enter')
    page.wait_for(f'!document.querySelector({row!r})')
    settle(page, 300)
    page.expect('!document.querySelector("[data-snowdrop=reply-bar]")', 'the reply bar is still up for a message that is gone')


@journey()
def suggestions_close_when_focus_leaves_the_composer(page):
    """"@" opens the member list; clicking a message moves focus out of the field, and the list must close with it."""
    open_conversation(page, 'allotment')
    page.click(COMPOSER)
    page.type('@')
    page.wait_for(LISTBOX)
    page.click(last_message_selector(page))
    page.wait_for(f'!({IN_COMPOSER})')
    settle(page, 300)
    page.expect(f'!({LISTBOX})', 'the suggestions stayed open after focus left the composer')


@journey()
def suggestions_stay_shut_when_a_draft_comes_back(page):
    """A draft "hi @" in a group, switch away and back: the chat opens with the draft, but no suggestion list until the user is typing in it."""
    open_conversation(page, 'allotment')
    page.click(COMPOSER)
    page.type('hi @')
    page.wait_for(LISTBOX)
    open_conversation(page, 'dm-priya')
    open_conversation(page, 'allotment')
    settle(page, 500)
    page.expect(f'document.querySelector({COMPOSER!r}).value === "hi @"', 'the draft did not come back')
    page.expect(f'!({IN_COMPOSER}) && !({LISTBOX})', 'the suggestions opened on their own')


@journey(
    known_bug='Files staged in the composer are dropped when you switch chats, though the typed draft is kept (attachments live in the composer component only, useAttachments). A judgment call: DECISIONS P7 says only that drafts persist.',
    fails_at='the staged file was dropped',
)
def staged_file_survives_a_chat_switch(page):
    """A file staged next to a draft is still staged when the user comes back to the chat, as the text is."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.type('with a file')
    page.eval(
        "(() => { const dt = new DataTransfer(); dt.items.add(new File(['abc'], 'a.txt', { type: 'text/plain' }));"
        " const i = document.querySelector('[data-snowdrop=composer] input[type=file]'); i.files = dt.files;"
        " i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()"
    )
    page.wait_for('!!document.querySelector("[data-snowdrop=attachment-tray]")')
    open_conversation(page, 'allotment')
    open_conversation(page, 'dm-priya')
    page.expect(f'document.querySelector({COMPOSER!r}).value === "with a file"', 'the draft did not come back')
    page.expect('!!document.querySelector("[data-snowdrop=attachment-tray]")', 'the staged file was dropped')
