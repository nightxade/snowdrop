from common import COMPOSER, IN_COMPOSER, LAST_MESSAGE, MESSAGE, ON_LIST, click_menu_item, deliver_and_find, emit, fill, is_current, open_conversation, open_menu, quiet, send, settle
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


def start_edit(page, text):
    """Sends `text`, then Up in the empty composer opens its editor with focus in it."""
    send(page, text)
    page.click(COMPOSER)
    page.key('ArrowUp')
    page.wait_for(IN_EDITOR)


EDITOR_TEXT = 'document.querySelector("[data-snowdrop=message] textarea")?.value'


@journey()
def saving_or_cancelling_an_edit_returns_focus_to_the_composer(page):
    """Save an edit with Enter, then edit again and cancel with Esc: focus goes to the composer both times, as in Discord and Signal Desktop (P4), so typing goes on at once."""
    open_conversation(page, 'dm-priya')
    start_edit(page, 'edit then write')
    page.type(' more')
    page.key('Enter')
    page.wait_for('!document.querySelector("[data-snowdrop=message] textarea")')
    page.wait_for(IN_COMPOSER)
    page.expect_stays(IN_COMPOSER, 500)
    page.key('ArrowUp')
    page.wait_for(IN_EDITOR)
    page.key('Escape')
    page.wait_for('!document.querySelector("[data-snowdrop=message] textarea")')
    page.wait_for(IN_COMPOSER)
    page.expect_stays(IN_COMPOSER, 500)


@journey()
def unsaved_edit_text_survives_a_chat_switch(page):
    """Type into an open editor, switch chats and come back: the editor is open again with the typed text."""
    open_conversation(page, 'dm-priya')
    start_edit(page, 'edit me')
    page.type(' and more')
    open_conversation(page, 'allotment')
    page.expect('!document.querySelector("[data-snowdrop=message] textarea")', 'the editor stayed open in the other chat')
    open_conversation(page, 'dm-priya')
    page.wait_for(f'{EDITOR_TEXT} === "edit me and more"')


@journey()
def up_on_the_message_being_edited_keeps_its_text(page):
    """Up in the empty composer while that same message is open in the editor goes back to the editor with what was typed, not to a fresh copy of the message."""
    open_conversation(page, 'dm-priya')
    start_edit(page, 'edit me again')
    page.type(' typed')
    page.click(COMPOSER)
    page.wait_for(IN_COMPOSER)
    page.key('ArrowUp')
    page.wait_for(IN_EDITOR, 1500)
    page.expect(f'{EDITOR_TEXT} === "edit me again typed"', 'the typed text was replaced')


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


@journey(motion=True)
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


@journey(motion=True)
def page_up_keeps_focus_on_the_list(page):
    """On the current message, PageUp a few screens up through a long chat: focus stays on the message list (a row, or the list itself), so the arrows keep working."""
    open_conversation(page, 'dm-priya')
    fill(page, 'dm-priya', 80)
    current_message(page)
    for _ in range(3):
        page.key('PageUp')
        settle(page, 700)
    page.expect(ON_LIST, 'focus is not on the message list after PageUp')
    page.key('ArrowUp')
    settle(page, 300)
    page.expect(ON_LIST, 'ArrowUp after PageUp left the list')


@journey()
def reaction_picker_esc_returns_to_the_message(page):
    """+ on the current message opens the emoji picker; Esc closes it and focus is back on the message (as after its menu), so R, E and the arrows still work."""
    open_conversation(page, 'dm-priya')
    row = f'[data-message-id="{current_message(page)}"]'
    page.key('+')
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(f'document.activeElement === document.querySelector({row!r})', 2000)


@journey()
def second_search_shortcut_keeps_focus(page):
    """Ctrl+F opens the search panel with focus in its field; Ctrl+F again closes it and focus goes to the composer, as after Esc, never <body>."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('f', ['ctrl'])
    page.wait_for('document.activeElement?.closest("[data-snowdrop=search-panel]") !== null')
    page.key('f', ['ctrl'])
    settle(page, 600)
    page.expect(IN_COMPOSER, 'focus is not in the composer after the second Ctrl+F')


@journey()
def member_panel_shortcut_keeps_focus(page):
    """The wide member panel is open with focus on one of its members; Ctrl+Shift+M closes it: focus goes to the header's member button, never to <body>."""
    open_conversation(page, 'allotment')
    page.wait_for('!!document.querySelector("[data-snowdrop=members]")')
    page.eval('const row = document.querySelector("[data-snowdrop=members] [data-snowdrop=member-row]"); row.focus(); return 1;')
    page.wait_for('document.activeElement?.closest("[data-snowdrop=members]") !== null')
    page.key('M', ['ctrl', 'shift'])
    page.wait_for('!document.querySelector("[data-snowdrop=members]")')
    settle(page, 400)
    page.expect('document.activeElement === document.querySelector("[data-snowdrop=member-toggle]")', 'focus did not go to the member button')


# ------------------------------------------------------------------ live events from the network


@journey()
def remote_delete_of_the_message_you_stepped_into_keeps_focus(page):
    """Enter steps into a message (focus on its hover bar); the sender deletes it for everyone: the row stays as a deleted message, and focus stays on it rather than falling to the page (M9, Esc steps out)."""
    open_conversation(page, 'dm-priya')
    author, sent = deliver_and_find(page, 'dm-priya', 'about to be deleted')
    deliver_and_find(page, 'dm-priya', 'a later message')
    row = f'[data-message-id="{author}:{sent}"]'
    settle(page, 500)
    page.click(row)
    page.wait_for(f'document.activeElement === document.querySelector({row!r})')
    page.key('Enter')
    page.wait_for(f'document.activeElement !== document.querySelector({row!r}) && document.querySelector({row!r}).contains(document.activeElement)')
    emit(page, 'messageDeleted', {'conversationId': page.eval('__journey.conversationId("dm-priya")'), 'authorId': author, 'targetSentAt': sent})
    page.wait_for(f'document.querySelector({row!r}).textContent.includes("was deleted")')
    settle(page, 400)
    page.expect(f'document.querySelector({row!r}).contains(document.activeElement)', 'focus fell to the page when the message it was in was deleted')


@journey()
def search_results_drop_a_message_deleted_for_everyone(page):
    """Ctrl+F finds a message; its sender deletes it for everyone while the results are up: its old text is no longer listed."""
    open_conversation(page, 'dm-priya')
    author, sent = deliver_and_find(page, 'dm-priya', 'needle in the haystack')
    page.click(COMPOSER)
    page.key('f', ['ctrl'])
    page.wait_for('document.activeElement?.closest("[data-snowdrop=search-panel]") !== null')
    page.type('needle')
    panel = 'document.querySelector("[data-snowdrop=search-panel]")'
    page.wait_for(f'{panel}.textContent.includes("needle in the haystack")')
    emit(page, 'messageDeleted', {'conversationId': page.eval('__journey.conversationId("dm-priya")'), 'authorId': author, 'targetSentAt': sent})
    page.wait_for(f'document.querySelector(\'[data-message-id="{author}:{sent}"]\').textContent.includes("was deleted")')
    settle(page, 600)
    page.expect(f'!{panel}.textContent.includes("needle in the haystack")', 'the deleted message is still listed in the search results')


# ------------------------------------------------------------------ a focused row that leaves hands focus on (M15)

MEMBER_ROWS = '[data-snowdrop=members] [data-snowdrop=member-row]'


def member_ids(page):
    return page.eval(f'[...document.querySelectorAll({MEMBER_ROWS!r})].map((e) => e.getAttribute("data-member-id"))')


def focus_member(page, member):
    page.eval(f'(document.querySelector(\'{MEMBER_ROWS}[data-member-id="{member}"]\').focus(), 1)')
    page.wait_for(f'document.activeElement?.getAttribute("data-member-id") === {member!r}')


@journey()
def removed_member_with_focus_hands_it_to_the_next_member_else_the_previous(page):
    """Focus is on a member's row and that member is removed from the group (by another admin): focus goes to the next member row; removing the last one puts it on the one before; never the page (M15)."""
    open_conversation(page, 'allotment')
    page.wait_for(f'document.querySelectorAll({MEMBER_ROWS!r}).length >= 4')
    me = page.eval('__journey.state().selfId')

    def remove(member):
        page.eval(f'__journey.removeMember("allotment", {member!r}), 1')
        page.wait_for(f'!document.querySelector(\'{MEMBER_ROWS}[data-member-id="{member}"]\')')
        settle(page, 300)

    def focused_is(member):
        return f'document.activeElement?.getAttribute("data-member-id") === {member!r}'

    members = member_ids(page)
    i = next(k for k in range(len(members) - 1) if members[k] != me)
    focus_member(page, members[i])
    remove(members[i])
    page.expect(focused_is(members[i + 1]), 'focus did not go to the next member')
    left = member_ids(page)
    last = len(left) - 1 if left[-1] != me else len(left) - 2
    assert last >= 1, 'the journey needs two members besides the user'
    focus_member(page, left[last])
    remove(left[last])
    expected = left[last + 1] if last + 1 < len(left) else left[last - 1]
    page.expect(focused_is(expected), 'focus did not go to a neighbour')


@journey()
def message_removed_on_the_phone_hands_focus_to_the_next_message_else_the_previous(page):
    """Focus is on a message that is deleted for me on the phone: focus goes to the next message; deleting the newest one puts it on the one before; never the page (M15, a focused row that disappears)."""
    open_conversation(page, 'dm-priya')
    conversation = page.eval('__journey.conversationId("dm-priya")')
    ids = []
    for text in ('first of three', 'second of three', 'third of three'):
        author, sent = deliver_and_find(page, 'dm-priya', text)
        ids.append(f'{author}:{sent}')
    settle(page, 500)

    def delete_on_the_phone(message):
        author, _, sent = message.rpartition(':')
        emit(page, 'deleteForMe', {'messages': [{'conversationId': conversation, 'authorId': author, 'sentAt': int(sent)}], 'conversations': []})
        page.wait_for(f'!document.querySelector(\'[data-message-id="{message}"]\')')
        settle(page, 300)

    def focused_is(message):
        return f'document.activeElement === document.querySelector(\'[data-message-id="{message}"]\')'

    page.click(f'[data-message-id="{ids[1]}"]')
    page.wait_for(focused_is(ids[1]))
    delete_on_the_phone(ids[1])
    page.expect(focused_is(ids[2]), 'focus did not go to the next message')
    delete_on_the_phone(ids[2])
    page.expect(focused_is(ids[0]), 'focus did not go to the previous message')


@journey()
def search_result_with_focus_that_leaves_hands_focus_on(page):
    """Ctrl+F finds two messages; Down twice puts focus on the second; its sender deletes it for everyone: the result leaves the list and focus goes to another result or the field, never the page (M15)."""
    open_conversation(page, 'dm-priya')
    author, sent = deliver_and_find(page, 'dm-priya', 'needle first')
    deliver_and_find(page, 'dm-priya', 'needle second')
    page.click(COMPOSER)
    page.key('f', ['ctrl'])
    page.wait_for('document.activeElement?.closest("[data-snowdrop=search-panel]") !== null')
    page.type('needle')
    page.wait_for('document.querySelectorAll("[data-snowdrop=search-panel] [data-search-result]").length === 2')
    page.key('ArrowDown')
    page.key('ArrowDown')
    page.wait_for('document.activeElement?.hasAttribute("data-search-result") && document.activeElement.textContent.includes("needle first")')
    emit(page, 'messageDeleted', {'conversationId': page.eval('__journey.conversationId("dm-priya")'), 'authorId': author, 'targetSentAt': sent})
    page.wait_for('document.querySelectorAll("[data-snowdrop=search-panel] [data-search-result]").length === 1')
    settle(page, 400)
    page.expect(NOT_ON_BODY, 'focus fell to the page when the result it was on left the results')


@journey()
def search_finds_a_message_by_the_name_it_mentions(page):
    """A message reading "hey @Juniper Hale about lunchtime" (the name is a mention) arrives: Ctrl+F finds it by "lunchtime", and also by "Juniper", the name the message and the result both show."""
    conversation = open_conversation(page, 'dm-priya')
    me = page.eval('__journey.state().selfId')
    sent = page.eval('Date.now()')
    emit(page, 'message', {'id': f'{me}:{sent}', 'conversationId': conversation, 'authorId': me, 'sentAt': sent, 'receivedAt': sent,
                           'body': 'hey \ufffc about lunchtime', 'ranges': [{'start': 4, 'length': 1, 'mentionId': me}],
                           'attachments': [], 'reactions': [], 'status': 'read', 'kind': 'normal'})
    page.wait_for(f'{LAST_MESSAGE}?.textContent.includes("lunchtime")')
    page.click(COMPOSER)
    page.key('f', ['ctrl'])
    page.wait_for('document.activeElement?.closest("[data-snowdrop=search-panel]") !== null')
    page.type('lunchtime')
    page.wait_for('document.querySelectorAll("[data-snowdrop=search-panel] [data-search-result]").length === 1')
    page.key('a', ['ctrl'])
    page.key('BackSpace')
    page.type('Juniper')
    settle(page, 800)
    page.expect('document.querySelectorAll("[data-snowdrop=search-panel] [data-search-result]").length === 1', 'a message mentioning Juniper is not found by searching for Juniper')


@journey()
def search_no_match_text_stays_inside_the_panel(page):
    """Ctrl+F, a 150-character link with no spaces pasted into the field: "No messages match" shows it within the panel, not running past its edge."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('f', ['ctrl'])
    page.wait_for('document.activeElement?.closest("[data-snowdrop=search-panel]") !== null')
    page.eval(
        'const i = document.querySelector("[data-snowdrop=search-panel] input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;'
        ' set.call(i, "https://example.test/" + "a".repeat(130)); i.dispatchEvent(new Event("input", { bubbles: true })); return 1'
    )
    page.wait_for('!!document.querySelector("[data-snowdrop=search-panel] svg") && document.querySelector("[data-snowdrop=search-panel]").textContent.includes("No messages match")')
    quiet(page)
    page.expect('(() => { const p = document.querySelector("[data-snowdrop=search-panel]"); return [...p.querySelectorAll("p")].every((e) => e.getBoundingClientRect().right <= p.getBoundingClientRect().right + 1); })()', 'the query text runs out of the search panel')


# ------------------------------------------------------------------ search panel: Esc closes it from anywhere in it


def open_search_with_results(page, word):
    page.click(COMPOSER)
    page.key('f', ['ctrl'])
    page.wait_for('document.activeElement?.closest("[data-snowdrop=search-panel]") !== null')
    page.type(word)
    page.wait_for('!!document.querySelector("[data-snowdrop=search-panel] [data-search-result]")')


NO_PANEL = '!document.querySelector("[data-snowdrop=search-panel]")'


@journey()
def search_esc_closes_the_panel_with_text_in_the_field_and_on_a_result(page):
    """Ctrl+F, a word typed: one Esc closes the panel (it does not clear the field first) and focus goes to the composer; the same from a result reached with Down; the panel's close button also ends in the composer (M15)."""
    open_conversation(page, 'dm-priya')
    deliver_and_find(page, 'dm-priya', 'needle in the haystack')
    open_search_with_results(page, 'needle')
    page.key('Escape')
    page.wait_for(NO_PANEL)
    page.wait_for(IN_COMPOSER, 2000)
    open_search_with_results(page, 'needle')
    page.key('ArrowDown')
    page.wait_for('document.activeElement?.hasAttribute("data-search-result")')
    page.key('Escape')
    page.wait_for(NO_PANEL)
    page.wait_for(IN_COMPOSER, 2000)
    open_search_with_results(page, 'needle')
    page.click('[data-snowdrop=search-panel] button[aria-label^="Close search"]')
    page.wait_for(NO_PANEL)
    page.wait_for(IN_COMPOSER, 2000)
    page.expect_stays(IN_COMPOSER, 400)


@journey()
def search_esc_closes_the_panel_after_enter_moved_focus_to_the_match(page):
    """Ctrl+F, a word, Enter: focus moves to the newest match in the list; Esc there closes the search panel (and does not mark the chat read), and focus goes to the composer."""
    open_conversation(page, 'dm-priya')
    author, sent = deliver_and_find(page, 'dm-priya', 'needle in the haystack')
    open_search_with_results(page, 'needle')
    page.key('Enter')
    row = f'[data-message-id="{author}:{sent}"]'
    page.wait_for(f'document.activeElement === document.querySelector({row!r})', 3000)
    page.key('Escape')
    page.wait_for(NO_PANEL)
    page.wait_for(IN_COMPOSER, 2000)


TOAST = '[data-sonner-toast]'
IN_TOASTS = 'document.activeElement?.closest("[data-sonner-toaster]") !== null && document.activeElement !== document.body'


@journey()
def esc_in_the_toast_list_returns_focus_to_where_it_was(page):
    """Focus is on a sidebar row, Alt+T moves it to the toasts and Esc puts it back on that row."""
    open_conversation(page, 'dm-priya')
    page.eval('(document.querySelector("[data-snowdrop=sidebar] [data-conversation-id][data-roving-item]").focus(), window.__row = document.activeElement, 1)')
    page.wait_for('document.activeElement === window.__row')
    page.eval('(__journey.toast("first"), __journey.toast("second"), 1)')
    page.wait_for(f'document.querySelectorAll({TOAST!r}).length === 2')
    page.key('t', ['alt'])
    page.wait_for(IN_TOASTS)
    page.key('Escape')
    page.wait_for('document.activeElement === window.__row')
    page.expect_stays('document.activeElement === window.__row', 300)


@journey()
def esc_in_the_toast_list_never_leaves_focus_on_the_page(page):
    """Nothing has focus, Alt+T moves it to the toasts, Tab onto one and Esc: focus goes to the fallback (M15), not back on a toast and not to the page."""
    open_conversation(page, 'dm-priya')
    page.eval('(document.activeElement.blur(), 1)')
    page.wait_for('document.activeElement === document.body')
    page.eval('(__journey.toast("first"), __journey.toast("second"), 1)')
    page.wait_for(f'document.querySelectorAll({TOAST!r}).length === 2')
    page.key('t', ['alt'])
    page.wait_for(IN_TOASTS)
    page.key('Tab')
    page.wait_for(f'document.activeElement?.matches({TOAST!r})')
    page.key('Escape')
    left = f'{NOT_ON_BODY} && !document.activeElement.closest("[data-sonner-toaster]")'
    page.wait_for(left, 2000)
    page.expect_stays(left, 300)


@journey()
def a_focused_toast_that_goes_hands_focus_to_the_next_toast_else_back(page):
    """Focus is on the first toast of two and it is dismissed: focus goes to the other toast; when that one goes too, back to the composer. Never the page."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.eval('(window.__ids = { first: __journey.toast("first"), second: __journey.toast("second") }, 1)')
    page.wait_for(f'document.querySelectorAll({TOAST!r}).length === 2')
    page.key('t', ['alt'])
    page.wait_for(IN_TOASTS)
    page.key('Tab')  # onto the first toast in the list
    page.wait_for(f'document.activeElement?.matches({TOAST!r})')
    page.eval('(window.__other = document.querySelectorAll("[data-sonner-toast]")[1], 1)')
    page.eval('const t = document.activeElement.textContent; __journey.dismissToast(window.__ids[t.includes("first") ? "first" : "second"]); return 1')
    page.wait_for('!document.body.contains(document.querySelector("[data-sonner-toast][data-removed=true]"))', 3000)
    page.wait_for('document.activeElement === window.__other', 3000)
    page.expect_stays('document.activeElement === window.__other', 300)
    page.eval('const t = document.activeElement.textContent; __journey.dismissToast(window.__ids[t.includes("first") ? "first" : "second"]); return 1')
    page.wait_for(IN_COMPOSER, 3000)


BANNER = '[data-snowdrop=connection-banner]'


@journey()
def the_connection_banners_retry_hands_focus_on_when_it_goes(page):
    """The connection drops and the banner offers Retry (and says a failed message can be retried, not that it will go out): pressing Retry reconnects and the banner goes; focus is not left on the page."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.eval("__journey.emit('status', 'offline')")
    page.wait_for(f'!!document.querySelector({BANNER!r})')
    page.expect(f'document.querySelector({BANNER!r}).textContent.includes("can be retried once the demo backend is back")', 'the banner promises something else')
    page.click(f'{BANNER} button')
    page.wait_for(f'!document.querySelector({BANNER!r})', 5000)
    page.wait_for(NOT_ON_BODY, 2000)
    page.expect_stays(NOT_ON_BODY, 300)


@journey()
def a_dialog_opened_from_the_toast_list_takes_focus(page):
    """Alt+T moves focus into the toast list; Ctrl+K opens the switcher: focus must be in the switcher, not back on the message behind it (M15, shortcuts open dialogs that own the keyboard)."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('Escape')
    page.eval('const _id = __journey.toast("a toast"); return 1')
    page.wait_for('!!document.querySelector("[data-sonner-toast]")')
    page.key('t', ['alt'])
    page.wait_for('document.activeElement?.closest("[data-sonner-toaster]") !== null')
    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[data-modal-dialog][data-state=open]")')
    quiet(page)
    page.expect('!!document.querySelector("[data-modal-dialog][data-state=open]")?.contains(document.activeElement)', 'focus is not in the open dialog')


@journey(
    settings={'keybinds': {'core.nextSpace': 'Ctrl+Alt+J'}},
)
def next_space_key_from_a_sidebar_row_keeps_focus_off_the_page(page):
    """Next space bound to a key (it has none by default): pressed with focus on a sidebar row, the list shows another space's chats; focus goes to one of them or the fallback, never the page (KEYBOARD.md, a focused row that goes hands focus on)."""
    open_conversation(page, 'dm-priya')
    page.eval('const r = document.querySelector("[data-snowdrop=sidebar] [data-conversation-id][tabindex=\\"0\\"]"); r.focus(); return 1')
    page.key('j', ['ctrl', 'alt'])
    page.wait_for('document.querySelector("[data-snowdrop=rail] button[aria-label^=\\"Home\\"]")?.getAttribute("aria-current") !== "true"')
    quiet(page)
    page.expect(NOT_ON_BODY, 'focus fell to the page when the space changed under the focused row')


# ------------------------------------------------------------------ message actions that take their own control away (M15)

HOVER_BAR = '[data-snowdrop=hover-bar]'


def react_from_the_bar(page):
    """Sends a message, hovers it and clicks the first quick reaction; returns the row's selector and its own reaction pill's."""
    open_conversation(page, 'dm-priya')
    send(page, 'react to me')
    row = '[data-message-id="%s"]' % page.eval(f'{LAST_MESSAGE}.getAttribute("data-message-id")')
    page.hover(row)
    page.wait_for(f'!!document.querySelector({HOVER_BAR!r})')
    page.click(f'{HOVER_BAR} button[aria-label^="React with"]')
    pill = f'{row} [aria-label=Reactions] button[aria-pressed=true]'
    page.wait_for(f'!!document.querySelector({pill!r})')
    return row, pill


@journey()
def removing_your_only_reaction_with_its_pill_keeps_focus_off_the_page(page):
    """Your only reaction on a message is its pill: Enter on the focused pill removes the reaction (and the pill), and focus must not fall to the page (M15: a focused thing that leaves hands focus on)."""
    _, pill = react_from_the_bar(page)
    page.eval(f'(document.querySelector({pill!r}).focus(), 1)')
    page.wait_for(f'document.activeElement === document.querySelector({pill!r})')
    page.key('Enter')
    page.wait_for(f'!document.querySelector({pill!r})')
    quiet(page)
    page.expect(NOT_ON_BODY, 'focus fell to the page when its own pill was removed')


@journey()
def hover_bar_button_clicked_then_pointer_leaves_keeps_focus_off_the_page(page):
    """Click a quick reaction in a message's hover bar, then move the pointer off the message: the bar stays while focus is inside it, so focus does not fall to the page (M15)."""
    row, _ = react_from_the_bar(page)
    page.expect(f'document.activeElement?.closest({HOVER_BAR!r}) !== null', 'the clicked bar button did not take focus (nothing to check)')
    page.hover('[data-snowdrop=sidebar]')
    quiet(page)
    page.expect(f'document.activeElement?.closest({HOVER_BAR!r}) != null', 'the hover bar went (or focus left it) with the pointer')


@journey()
def pinned_list_drops_a_message_deleted_for_everyone(page):
    """The Pinned messages list is open; the sender deletes a pinned message for everyone: its old text is no longer listed, as in the chat search (C14)."""
    open_conversation(page, 'dm-priya')
    author, sent = deliver_and_find(page, 'dm-priya', 'pinned and then deleted')
    row = f'[data-message-id="{author}:{sent}"]'
    open_menu(page, row)
    page.wait_for('[...document.querySelectorAll("[role^=menuitem]")].some((e) => e.textContent.includes("Pin message"))')
    click_menu_item(page, 'Pin message')
    page.wait_for('[...document.querySelectorAll("[data-snowdrop=system-message]")].some((e) => e.textContent.includes("pinned a message"))')
    page.click('[data-snowdrop=chat-header] button[aria-label="Pinned messages"]')
    listed = 'document.querySelector("[role=dialog]")?.textContent.includes("pinned and then deleted") === true'
    page.wait_for(listed)
    emit(page, 'messageDeleted', {'conversationId': page.eval('__journey.conversationId("dm-priya")'), 'authorId': author, 'targetSentAt': sent})
    page.wait_for(f'document.querySelector({row!r}).textContent.includes("was deleted")')
    quiet(page)
    page.expect(f'!({listed})', 'the deleted message is still listed in the pinned messages')


@journey()
def e_on_an_own_message_past_the_edit_window_says_why(page):
    """Your own message is older than 24 hours; E on it does not open an editor and says why ("Messages can only be edited for 24 hours", M2), instead of typing an "e" into the composer."""
    open_conversation(page, 'dm-priya')
    own = page.eval(
        f"""(() => {{ const me = __journey.state().selfId, now = Date.now();
          const old = [...document.querySelectorAll({MESSAGE!r})].filter((e) => e.getAttribute('data-message-id').startsWith(me + ':')
            && now - Number(e.getAttribute('data-message-id').split(':').pop()) > 25 * 3600 * 1000);
          return old.length ? old[old.length - 1].getAttribute('data-message-id') : null; }})()"""
    )
    page.expect(f'{own!r} !== null', 'the demo chat has no message of yours older than a day')
    row = f'[data-message-id="{own}"]'
    page.click(row)
    page.wait_for(f'document.activeElement === document.querySelector({row!r})')
    page.key('e')
    quiet(page)
    page.expect(f'document.querySelector({COMPOSER!r}).value === "" && !document.querySelector("[data-snowdrop=message] textarea")', 'E typed into the composer on a message that cannot be edited')
    page.expect('document.body.textContent.includes("can only be edited for 24 hours")', 'E gave no reason')


@journey()
def picking_the_emoji_you_reacted_with_removes_it(page):
    """Your reaction is on a message; picking the same emoji again from the hover bar removes it, as in Signal Desktop and Discord."""
    _, pill = react_from_the_bar(page)
    page.click(f'{HOVER_BAR} button[aria-label^="React with"]')
    page.wait_for(f'!document.querySelector({pill!r})', 3000)


@journey()
def starting_another_edit_keeps_the_first_editors_text(page):
    """Text typed in one message's editor is kept when you start editing another message: editing the first again reopens it with that text (P4)."""
    open_conversation(page, 'dm-priya')
    send(page, 'first one')
    first = f'[data-message-id="{page.eval(f"{LAST_MESSAGE}.getAttribute(\"data-message-id\")")}"]'
    send(page, 'second one')
    second = f'[data-message-id="{page.eval(f"{LAST_MESSAGE}.getAttribute(\"data-message-id\")")}"]'
    editor = 'document.querySelector("[data-snowdrop=message] textarea")'
    page.click(COMPOSER)
    page.key('ArrowUp')
    page.wait_for(f'{editor}?.value === "second one"')
    page.type(' plus')
    page.click(first)
    page.wait_for(f'document.activeElement === document.querySelector({first!r})')
    page.key('e')
    page.wait_for(f'{editor}?.value === "first one"')
    page.click(second)
    page.wait_for(f'document.activeElement === document.querySelector({second!r})')
    page.key('e')
    page.wait_for(f'{editor}?.value === "second one plus"', 3000)


@journey()
def a_quote_of_a_message_deleted_for_everyone_stops_showing_its_text(page):
    """You replied to a message and its sender then deletes it for everyone: your reply's quote says "This message was deleted" instead of showing the text it had."""
    open_conversation(page, 'dm-priya')
    author, sent = deliver_and_find(page, 'dm-priya', 'quoted words')
    row = f'[data-message-id="{author}:{sent}"]'
    page.click(row)
    page.wait_for(f'document.activeElement === document.querySelector({row!r})')
    page.key('r')
    page.wait_for(IN_COMPOSER)
    send(page, 'my answer')
    quote = f'{LAST_MESSAGE}.querySelector("[data-snowdrop=message-quote]")'
    page.expect(f'{quote}?.textContent.includes("quoted words") === true', 'the reply does not quote the message (nothing to check)')
    emit(page, 'messageDeleted', {'conversationId': page.eval('__journey.conversationId("dm-priya")'), 'authorId': author, 'targetSentAt': sent})
    page.wait_for(f'document.querySelector({row!r}).textContent.includes("was deleted")')
    quiet(page)
    page.expect(f'{quote}.textContent.includes("was deleted") && !{quote}.textContent.includes("quoted words")', 'the quote still shows the deleted message')


@journey()
def an_edit_saved_after_another_device_edited_the_message_is_sent(page):
    """The editor is open with the text it opened with; another device edits the message; saving the editor's text (which differs from the message now) sends the edit instead of closing as if nothing changed."""
    open_conversation(page, 'dm-priya')
    send(page, 'alpha')
    author, _, sent = page.eval(f'{LAST_MESSAGE}.getAttribute("data-message-id")').rpartition(':')
    page.click(COMPOSER)
    page.key('ArrowUp')
    page.wait_for('document.activeElement?.matches("[data-snowdrop=message] textarea")')
    page.type(' ')  # a draft that still says "alpha" once trimmed: what the editor opened with
    emit(page, 'messageEdited', {'conversationId': page.eval('__journey.conversationId("dm-priya")'), 'authorId': author, 'targetSentAt': int(sent), 'body': 'beta', 'ranges': [], 'editedAt': int(sent) - 1})
    page.wait_for('document.body.textContent.includes("beta")')  # the sidebar preview has the other device's text
    page.key('Enter')
    page.wait_for('!document.querySelector("[data-snowdrop=message] textarea")')
    page.wait_for(f'{LAST_MESSAGE}.textContent.includes("alpha") && !{LAST_MESSAGE}.textContent.includes("beta")', 3000)
