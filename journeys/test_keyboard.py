from common import COMPOSER, LAST_MESSAGE, MESSAGE, is_current, open_conversation, send
from harness import journey

NOT_ON_BODY = 'document.activeElement !== document.body'

@journey()
def esc_from_the_composer(page):
    """Esc after sending leaves the field: the newest message becomes current and stays current; arrows move between messages."""
    open_conversation(page, 'dm-priya')
    for text in ('one', 'two', 'three'):
        send(page, text)
    page.key('Escape')
    page.wait_for(is_current(0))
    page.expect_stays(is_current(0), 1200)
    page.key('ArrowUp')
    page.wait_for(is_current(1))
    page.key('ArrowDown')
    page.wait_for(is_current(0))


@journey()
def reply_then_edit(page):
    """Reply to a message from the keyboard, then edit your own last message with Up in an empty composer; both render."""
    open_conversation(page, 'dm-priya')
    send(page, 'a first message')
    page.key('Escape')
    page.wait_for(is_current(0))
    page.key('ArrowUp')  # a message from Priya, above ours
    page.wait_for(is_current(1))
    page.key('r')
    page.wait_for('!!document.querySelector("[data-snowdrop=reply-bar]")')
    page.expect(f'document.activeElement === document.querySelector({COMPOSER!r})', 'reply did not focus the composer')
    page.type('this is the reply')
    page.key('Enter')
    page.wait_for(
        f'(() => {{ const m = [...document.querySelectorAll({MESSAGE!r})]; const e = m[m.length - 1];'
        ' return !!e && e.textContent.includes("this is the reply") && !e.hasAttribute("data-pending")'
        ' && !!e.querySelector("[data-snowdrop=message-quote]"); })()'
    )
    page.expect(f'document.activeElement === document.querySelector({COMPOSER!r})', 'the composer lost focus after the reply')
    page.key('ArrowUp')  # empty composer: edit the last message
    page.wait_for('!!document.querySelector("[data-snowdrop=message] textarea")')
    page.type(' (edited)')
    page.key('Enter')
    page.wait_for(
        f'(() => {{ const m = [...document.querySelectorAll({MESSAGE!r})]; const e = m[m.length - 1];'
        ' return !!e && e.textContent.includes("this is the reply (edited)") && !document.querySelector("[data-snowdrop=message] textarea"); })()'
    )


@journey()
def esc_right_after_sending(page):
    """Esc straight after Enter, before the send has finished: the newest message stays current."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    # The row must not leave the page (taking focus with it) while the sent message replaces the
    # pending one: a polling check can miss a gap of a few ms, so the page itself watches for it.
    page.eval(
        'const _ = (window.__gone = 0);'
        ' new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes)'
        ' if (n.nodeType === 1 && (n.matches("[data-pending],[data-current]") || n.querySelector("[data-pending],[data-current]"))) window.__gone++; })'
        '.observe(document.body, { childList: true, subtree: true }); return 1;'
    )
    page.type('sent in a hurry')
    page.key('Enter')
    page.key('Escape')
    page.wait_for(is_current(0))
    page.wait_for(f'!{LAST_MESSAGE}.hasAttribute("data-pending")')
    page.expect_stays(is_current(0), 1500)
    page.expect('window.__gone === 0', 'the pending message row left the page (and its focus) when the sent message replaced it')


@journey()
def alt_arrow_from_the_composer_into_a_new_chat(page):
    """Alt+Down from the composer steps to the next chat (never opened before): focus lands on its message list (or its row), never on <body>."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('ArrowDown', ['alt'])
    page.wait_for('__journey.state().selected !== __journey.conversationId("dm-priya")')
    page.wait_for(NOT_ON_BODY, 1500)
    page.expect_stays(NOT_ON_BODY, 1000)  # it lands somewhere real and stays there


@journey()
def switcher_enter_into_a_new_chat(page):
    """Ctrl+K, a name, Enter opens that chat (never opened before) and focus lands on its message list, never <body>."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.type('raff')
    page.key('Enter')
    page.wait_for('__journey.state().selected === __journey.conversationId("dm-rafferty")')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(NOT_ON_BODY, 1500)
    page.expect_stays(NOT_ON_BODY, 1000)


LOADED = f'document.querySelectorAll({MESSAGE!r}).length > 0'


@journey()
def alt_arrow_into_a_slow_loading_chat(page):
    """Alt+Down from the composer into a chat whose messages take 2.5 s to load: when they arrive and the list is rebuilt, focus is still on the list, never <body>."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.eval('__journey.setLoadDelay(2500)')
    page.key('ArrowDown', ['alt'])
    page.wait_for('__journey.state().selected !== __journey.conversationId("dm-priya")')
    page.wait_for(LOADED, 8000)
    page.wait_for(NOT_ON_BODY, 1500)
    page.expect_stays(NOT_ON_BODY, 1000)


@journey()
def switcher_enter_into_a_slow_loading_chat(page):
    """The same through the quick switcher: a chat whose messages take 2.5 s to load keeps focus on its list."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.eval('__journey.setLoadDelay(2500)')
    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.type('raff')
    page.key('Enter')
    page.wait_for('__journey.state().selected === __journey.conversationId("dm-rafferty")')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(LOADED, 8000)
    page.wait_for(NOT_ON_BODY, 1500)
    page.expect_stays(NOT_ON_BODY, 1000)


IN_EDITOR = 'document.activeElement?.matches("[data-snowdrop=message] textarea")'


@journey()
def edit_the_same_message_twice(page):
    """Up in an empty composer opens the editor with focus in it; after Esc, Up again does the same for the same message."""
    open_conversation(page, 'dm-priya')
    send(page, 'edit me twice')
    page.click(COMPOSER)
    page.key('ArrowUp')
    page.wait_for(IN_EDITOR)
    page.key('Escape')
    page.wait_for('!document.querySelector("[data-snowdrop=message] textarea")')
    page.click(COMPOSER)
    page.key('ArrowUp')
    page.wait_for('!!document.querySelector("[data-snowdrop=message] textarea")')
    page.wait_for(IN_EDITOR, 1500)


MENU = '[role=menu]'
IN_HOVER_BAR = 'document.activeElement?.closest("[data-snowdrop=hover-bar]") !== null'


def current_message(page):
    """Esc from the composer leaves the newest message current and focused; returns its id."""
    page.click(COMPOSER)
    page.key('Escape')
    page.wait_for(is_current(0))
    return page.eval('document.activeElement.getAttribute("data-message-id")')


@journey()
def enter_steps_into_a_message_and_escape_out(page):
    """Enter on the current message moves focus into its hover bar (Tab goes on through the controls); Esc puts it back on the message."""
    open_conversation(page, 'dm-priya')
    row = f'[data-message-id="{current_message(page)}"]'
    page.key('Enter')
    page.wait_for(IN_HOVER_BAR)
    first = page.eval('document.activeElement.getAttribute("aria-label")')
    page.key('Tab')
    page.expect(f'{IN_HOVER_BAR} && document.activeElement.getAttribute("aria-label") !== {first!r}', 'Tab did not go on to the next control')
    page.key('Escape')
    page.wait_for(f'document.activeElement === document.querySelector({row!r})')
    page.expect_stays(is_current(0), 500)


@journey()
def message_menu_keys_open_the_menu(page):
    """Shift+F10, the Menu key and Ctrl+Enter each open the current message's menu, and closing it with Esc gives focus back to the message."""
    open_conversation(page, 'dm-priya')
    row = f'[data-message-id="{current_message(page)}"]'
    for name, mods in (('F10', ['shift']), ('Menu', []), ('Enter', ['ctrl'])):
        page.key(name, mods)
        page.wait_for(f'!!document.querySelector({MENU!r})')
        page.expect(f'document.querySelector({MENU!r}).contains(document.activeElement)', f'{name}: focus did not move into the menu')
        page.key('Escape')
        page.wait_for(f'!document.querySelector({MENU!r})')
        page.wait_for(f'document.activeElement === document.querySelector({row!r})')


# What a row paints: its background and shadow (the accent bar on its left edge).
def painted(from_end):
    return f"""(() => {{
      const m = [...document.querySelectorAll({MESSAGE!r})];
      const s = getComputedStyle(m[m.length - 1 - {from_end}]);
      return {{ bg: s.backgroundColor, shadow: s.boxShadow }};
    }})()"""


ACCENT = """(() => { const p = document.createElement('span'); p.style.color = 'var(--snowdrop-accent)';
  document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })()"""


@journey()
def current_message_is_painted(page):
    """The current message is painted (an accent bar and a background) while focus is on the list, in WebKitGTK where :focus-visible does not show for script focus; the row before it is not, and the paint moves with the arrows."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('Escape')
    page.wait_for(is_current(0))
    page.wait_for(f'{painted(0)}.shadow.includes({ACCENT}) && {painted(0)}.bg !== {painted(1)}.bg')
    page.expect(f'!{painted(1)}.shadow.includes({ACCENT})', 'the previous message is painted as current too')
    page.key('ArrowUp')
    page.wait_for(is_current(1))
    page.wait_for(f'{painted(1)}.shadow.includes({ACCENT}) && !{painted(0)}.shadow.includes({ACCENT})')
    # Focus that is not :focus-visible (a mouse click on a message) paints it too: the marker does not depend on that.
    third = page.eval(f'[...document.querySelectorAll({MESSAGE!r})].at(-3).getAttribute("data-message-id")')
    page.click(f'[data-message-id="{third}"]')
    page.wait_for('document.activeElement?.matches("[data-snowdrop=message]") && !document.activeElement.matches(":focus-visible")')
    page.wait_for(f'{painted(2)}.shadow.includes({ACCENT})')
