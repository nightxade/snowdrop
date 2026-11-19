import json

from common import COMPOSER, IN_COMPOSER, click_menu_item, click_text, emit, forget_expected_send_failures, is_current, open_conversation, open_menu, quiet, select_space, send, settle
from harness import journey

NEW_MESSAGE = '[data-snowdrop=sidebar-header] button[aria-label="New message"]'
SETTINGS = '[data-snowdrop=user-panel] button[aria-label="Settings"]'


def returns_focus_to(page, button):
    """Clicks `button`, waits for the dialog, closes it with Esc: focus must be back on `button`."""
    page.click(button)
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(f'document.activeElement === document.querySelector({button!r})')


@journey()
def dialog_returns_focus_to_its_button(page):
    """A dialog opened from a button gives focus back to that button when Esc closes it."""
    returns_focus_to(page, NEW_MESSAGE)
    returns_focus_to(page, SETTINGS)


@journey()
def replaced_dialog_returns_focus_to_the_first_opener(page):
    """New message, then New group inside it (one dialog replaces the other): closing the second gives focus back to the New message button, not to the page."""
    page.click(NEW_MESSAGE)
    page.wait_for('!!document.querySelector("[role=dialog]")')
    click_text(page, '[role=dialog] [role=option], [role=dialog] [cmdk-item]', 'New group')
    page.wait_for('/group/i.test(document.querySelector("[role=dialog]")?.getAttribute("aria-label") ?? document.querySelector("[role=dialog]")?.textContent ?? "") && !document.querySelector("[role=dialog] [cmdk-item]")', 5000)
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(f'document.activeElement === document.querySelector({NEW_MESSAGE!r})')
    page.expect_stays(f'document.activeElement === document.querySelector({NEW_MESSAGE!r})', 500)


@journey()
def palette_command_dialog_returns_focus_to_what_had_it(page):
    """From a message: Ctrl+K, a command that opens a dialog (Open settings), Esc: focus goes back to that message, not to <body> or the composer (the palette that held it is gone)."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.key('Escape')
    page.wait_for(is_current(0))
    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.type('>open settings')
    page.key('Enter')
    page.wait_for('/settings/i.test(document.querySelector("[role=dialog]")?.getAttribute("aria-label") ?? "") || !!document.querySelector("[data-snowdrop=settings]")', 5000)
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(is_current(0))
    page.expect_stays(is_current(0), 500)


@journey()
def message_menu_dialog_returns_focus_to_the_message(page):
    """On a message: Ctrl+Enter, "Delete for me" from the menu, Esc on the question: focus is back on the message the menu was opened from."""
    open_conversation(page, 'dm-priya')
    send(page, 'menu then dialog')
    page.key('Escape')
    page.wait_for(is_current(0))
    row = f'[data-message-id="{page.eval("document.activeElement.getAttribute(\'data-message-id\')")}"]'
    page.key('Enter', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=menu]")')
    click_text(page, '[role=menu] [role=menuitem]', 'Delete for me')
    page.wait_for('!!document.querySelector("[role=dialog], [role=alertdialog]")')
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog], [role=alertdialog]")')
    page.wait_for(f'document.activeElement === document.querySelector({row!r})', 2000)  # focus back on the message


@journey()
def alt_arrow_in_settings_leaves_the_open_chat(page):
    """Settings open over a chat: Alt+Down does not switch the chat behind the dialog."""
    open_conversation(page, 'dm-priya')
    opened = page.eval('__journey.state().selected')
    page.key(',', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    settle(page, 300)
    page.key('ArrowDown', ['alt'])
    settle(page, 700)
    page.expect(f'__journey.state().selected === {opened!r}', 'Alt+Down changed the chat behind Settings')


@journey()
def request_answered_on_the_phone_under_an_open_dialog(page):
    """Block or Delete on a message request asks first; the phone accepts the request meanwhile: the question goes with the bar, and focus goes to the fallback (what had it before, else the composer), not the page."""
    conversation = page.eval('__journey.conversationId("request-dm")')
    page.click(f'[data-conversation-id="{conversation}"]')
    page.wait_for('!!document.querySelector("[data-snowdrop=message-request]")')
    click_text(page, '[data-snowdrop=message-request] button', 'Delete')
    page.wait_for('!!document.querySelector("[role=alertdialog], [role=dialog]")')
    emit(page, 'messageRequestResponse', {'conversationId': conversation, 'answer': 'accept', 'at': 4000000000000})
    page.wait_for(f'!document.querySelector("[role=alertdialog], [role=dialog]") && !!document.querySelector({COMPOSER!r})')
    settle(page, 500)
    page.expect('document.activeElement !== document.body', 'focus fell to the page when the request was answered under its dialog')


@journey()
def dialogs_of_a_message_close_when_it_is_deleted_for_everyone(page):
    """The delete question or Message details is open on a message; the sender deletes it for everyone from another device: the dialog goes with the message, and focus is not left on the page (M15)."""
    open_conversation(page, 'dm-priya')
    conversation = page.eval('__journey.conversationId("dm-priya")')
    dialog = 'document.querySelector("[role=alertdialog], [role=dialog]")'
    for text, open_dialog in (
        ('delete question', lambda: page.key('Delete')),
        ('details question', lambda: (page.key('Enter', ['ctrl']), page.wait_for('!!document.querySelector("[role=menu]")'),
                                      click_text(page, '[role=menu] [role=menuitem]', 'Message details'))),
    ):
        send(page, text)
        page.key('Escape')
        page.wait_for(is_current(0))
        author, _, sent = page.eval('document.activeElement.getAttribute("data-message-id")').rpartition(':')
        open_dialog()
        page.wait_for(f'!!{dialog}')
        emit(page, 'messageDeleted', {'conversationId': conversation, 'authorId': author, 'targetSentAt': int(sent)})
        page.wait_for(f'!{dialog}')
        settle(page, 500)
        page.expect('document.activeElement !== document.body', f'focus fell to the page when the {text} dialog closed under it')


@journey()
def settings_nav_item_with_focus_hides_when_the_window_narrows(page):
    """Settings open with focus on a section of its nav and a page showing; the window narrows below 760 px, where a page shows without the nav: focus goes to the page's heading, not the page (M15)."""
    page.key(',', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    click_text(page, '[role=dialog] button', 'Appearance')
    page.wait_for('document.activeElement?.getAttribute("data-page-id") === "appearance"')
    page.resize(700, 800)
    settle(page, 500)
    page.expect('document.activeElement?.hasAttribute("data-page-heading") === true', 'focus did not go to the page heading')


DIALOG = '!!document.querySelector("[role=dialog]")'
REVIEW = '[...document.querySelectorAll("[data-snowdrop=message] button")].some((b) => b.textContent.trim() === "Review safety number")'


def send_to_annika(page, text):
    """Sends to Annika, whose changed key refuses the message a moment after it is sent."""
    page.eval('__journey.setSendDelay(500)')
    open_conversation(page, 'dm-annika')
    page.click(COMPOSER)
    page.type(text)
    page.key('Enter')
    page.wait_for('!!document.querySelector("[data-snowdrop=message][data-pending]")')


@journey()
def a_failed_send_opens_the_safety_number_dialog_when_the_user_is_idle(page):
    """Send to Annika (her safety number changed) and do nothing: when the send fails, the Safety Number Changes dialog opens by itself."""
    send_to_annika(page, 'hello')
    page.wait_for(DIALOG, 5000)
    forget_expected_send_failures(page)


@journey()
def a_failed_send_does_not_take_focus_from_typing(page):
    """Send to Annika and keep typing the next message: when the send fails, no dialog opens over it and focus stays in the composer with the text intact; the failed message says so and still offers Review safety number."""
    send_to_annika(page, 'hello')
    page.type('and more')
    page.wait_for(REVIEW, 5000)
    quiet(page)
    page.expect_stays('!document.querySelector("[role=dialog]")', 800)
    page.expect(f'{IN_COMPOSER} && document.querySelector({COMPOSER!r}).value === "and more"', 'focus or the typed text was taken')
    forget_expected_send_failures(page)


@journey()
def new_group_made_inside_a_space_opens_in_home(page):
    """In the Family space, New message (from the palette) then New group (no members, a name): the group is made in Home, so Home is shown with the new group open and selected."""
    select_space(page, 'Family')
    page.wait_for('!!document.querySelector("[data-snowdrop=sidebar] [data-conversation-id]")')
    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    page.type('>new message')
    page.key('Enter')
    page.wait_for('[...document.querySelectorAll("[role=dialog] [role=option], [role=dialog] [cmdk-item]")].some((e) => e.textContent.trim() === "New group")', 5000)
    click_text(page, '[role=dialog] [role=option], [role=dialog] [cmdk-item]', 'New group')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Next without members")')
    click_text(page, '[role=dialog] button', 'Next without members')
    page.wait_for('document.activeElement?.matches("[role=dialog] input")')
    page.type('Weekend plans')
    page.key('Enter')
    page.wait_for('!document.querySelector("[role=dialog]")')
    quiet(page)
    page.expect('document.querySelector("[data-snowdrop=rail] [aria-current=page]")?.getAttribute("aria-label").startsWith("Home")', 'the new group did not open in Home')
    page.expect('document.querySelector("[data-snowdrop=sidebar] [data-selected] [data-conversation-id]")?.getAttribute("aria-label").startsWith("Weekend plans")', 'the new group is not the selected chat')


REQUEST_BAR = '[data-snowdrop=message-request]'
FOCUS_ON_PAGE = 'document.activeElement !== document.body'


def open_request(page):
    conversation = page.eval('__journey.conversationId("request-dm")')
    page.click(f'[data-conversation-id="{conversation}"]')
    page.wait_for(f'!!document.querySelector({REQUEST_BAR!r})')
    return conversation


def focus_bar_button(page, text):
    page.eval(f'([...document.querySelectorAll("{REQUEST_BAR} button")].find((b) => b.textContent.trim() === {text!r}).focus(), 1)')
    page.wait_for(f'document.activeElement.textContent.trim() === {text!r}')


@journey()
def request_accepted_on_the_phone_under_its_focused_accept_button(page):
    """Tab has put focus on Accept in a message request; the phone accepts it meanwhile: the bar goes, and focus is not left on the page (M15)."""
    conversation = open_request(page)
    focus_bar_button(page, 'Accept')
    emit(page, 'messageRequestResponse', {'conversationId': conversation, 'answer': 'accept', 'at': 4000000000000})
    page.wait_for(f'!document.querySelector({REQUEST_BAR!r})')
    quiet(page)
    page.expect(FOCUS_ON_PAGE, 'focus fell to the page when the phone accepted the request under its focused Accept button')


@journey()
def request_blocked_on_the_phone_under_its_focused_block_button(page):
    """Focus is on Block in a message request; the phone blocks it meanwhile (the bar becomes the blocked bar, which has no Block): focus is not left on the page (M15)."""
    conversation = open_request(page)
    focus_bar_button(page, 'Block')
    emit(page, 'messageRequestResponse', {'conversationId': conversation, 'answer': 'block', 'at': 4000000000000})
    page.wait_for(f'document.querySelector({REQUEST_BAR!r})?.getAttribute("data-state") === "blocked"')
    quiet(page)
    page.expect(FOCUS_ON_PAGE, 'focus fell to the page when the phone blocked the request under its focused Block button')


@journey()
def deleting_a_request_from_its_bar_keeps_focus_off_the_page(page):
    """Delete on a message request, confirmed: the chat is gone and unselected; focus goes to the neighbouring row of the conversation list, as when the phone deletes it, not the page (M15)."""
    conversation = open_request(page)
    rows = 'JSON.stringify([...document.querySelectorAll("[data-snowdrop=conversation-list] [data-row-id]")].map((r) => r.getAttribute("data-row-id")))'
    before = json.loads(page.eval(rows))
    click_text(page, f'{REQUEST_BAR} button', 'Delete')
    page.wait_for('!!document.querySelector("[role=alertdialog], [role=dialog]")')
    click_text(page, '[role=alertdialog] button, [role=dialog] button', 'Delete')
    page.wait_for(f'!document.querySelector({REQUEST_BAR!r})')
    quiet(page)
    after = [r for r in before if r != conversation]
    at = before.index(conversation)
    neighbour = before[at + 1] if at + 1 < len(before) else before[at - 1]
    assert neighbour in after
    page.expect(f'document.activeElement?.closest("[data-snowdrop=conversation-list] [data-row-id]")?.getAttribute("data-row-id") === {neighbour!r}', 'focus is not on the row next to the deleted request after Delete was confirmed')


def group_details(page, key):
    """Opens a group and returns what a phone-side update of it has to repeat: its id, title, members and our id."""
    conversation = open_conversation(page, key)
    if not page.eval('!!document.querySelector("[data-snowdrop=members]")'):
        page.click('[data-snowdrop=member-toggle]')
    page.wait_for('!!document.querySelector("[data-snowdrop=member-row]")')
    members = page.eval('[...document.querySelectorAll("[data-snowdrop=member-row]")].map((e) => e.getAttribute("data-member-id"))')
    me = page.eval('__journey.state().selfId')
    title = page.eval(f'__journey.state().conversations.find((c) => c.key === {key!r}).title')
    return conversation, title, members, me


def update_group(page, details, admins, rules, **more):
    """The phone changes the group: who its admins are, its rules, and anything else (`left`)."""
    conversation, title, members, _ = details
    emit(page, 'conversationUpdated', {
        'id': conversation, 'kind': 'group', 'title': title, 'memberIds': members, 'adminIds': admins,
        'expireTimerSec': 0, 'lastActivityAt': 4000000000000,
        'permissions': {'addMember': 'every-member', 'editDetails': 'every-member', 'sendMessages': 'every-member', **rules}, **more,
    })


@journey()
def group_made_admin_only_under_a_focused_composer(page):
    """Typing in a group's composer; another admin makes the group admins-only (you are not one): the composer gives way to the notice, and focus is not left on the page (M15)."""
    details = group_details(page, 'allotment')
    members, me = details[2], details[3]
    page.click(COMPOSER)
    page.type('half a thought')
    update_group(page, details, [m for m in members if m != me][:1], {'sendMessages': 'only-admins'})
    page.wait_for('!!document.querySelector("[data-state=announcement]")')
    quiet(page)
    page.expect(FOCUS_ON_PAGE, 'focus fell to the page when the composer was replaced by the announcement notice')


@journey()
def group_left_on_another_device_under_a_focused_composer(page):
    """Typing in a group's composer; you leave the group on the phone: the composer gives way to the left notice, and focus is not left on the page (M15)."""
    details = group_details(page, 'allotment')
    page.click(COMPOSER)
    page.type('half a thought')
    update_group(page, details, [], {}, left=True)
    page.wait_for('!!document.querySelector("[data-state=left]")')
    quiet(page)
    page.expect(FOCUS_ON_PAGE, 'focus fell to the page when the composer was replaced by the left notice')


@journey()
def chat_blocked_on_the_phone_under_a_focused_composer(page):
    """Typing in a direct chat's composer; the phone blocks that person: the composer gives way to the blocked bar, and focus is not left on the page (M15)."""
    conversation = open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.type('half a thought')
    emit(page, 'messageRequestResponse', {'conversationId': conversation, 'answer': 'block', 'at': 4000000000000})
    page.wait_for(f'document.querySelector({REQUEST_BAR!r})?.getAttribute("data-state") === "blocked"')
    quiet(page)
    page.expect(FOCUS_ON_PAGE, 'focus fell to the page when the composer was replaced by the blocked bar')


def open_group_dialog(page, action, dialog):
    """From the group's details popover (its name in the chat header), the action that opens `dialog`."""
    page.click('[data-snowdrop=chat-header] h1 button')
    page.wait_for('!!document.querySelector("[role=dialog]")')
    click_text(page, '[role=dialog] button', action)
    page.wait_for(f'[...document.querySelectorAll("[role=dialog]")].some((d) => d.textContent.includes({dialog!r}))')


TOAST = '[data-sonner-toast]'


@journey()
def edit_group_closes_when_you_lose_the_right_to_change_it(page):
    """Edit group is open; meanwhile you stop being an admin of a group only admins may edit: the dialog closes with a short notice instead of refusing later, and focus is not left on the page (M15)."""
    details = group_details(page, 'allotment')
    members, me = details[2], details[3]
    update_group(page, details, [me], {})
    open_group_dialog(page, 'Edit group', 'Group name')
    update_group(page, details, [m for m in members if m != me][:1], {'editDetails': 'only-admins'})
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(f'document.querySelector({TOAST!r})?.textContent.includes("You can no longer change this group")')
    quiet(page)
    page.expect(FOCUS_ON_PAGE, 'focus fell to the page when the Edit group dialog closed under the user')


@journey()
def leave_group_closes_when_you_already_left_on_the_phone(page):
    """Leave group is asking; meanwhile you leave on the phone: the dialog closes with a short notice (there is nothing left to leave), and focus is not left on the page (M15)."""
    details = group_details(page, 'allotment')
    open_group_dialog(page, 'Leave group', 'You will no longer be able to send')
    update_group(page, details, [], {}, left=True)
    page.wait_for('!document.querySelector("[role=dialog]")')
    page.wait_for(f'document.querySelector({TOAST!r})?.textContent.includes("no longer in this group")')
    quiet(page)
    page.expect(FOCUS_ON_PAGE, 'focus fell to the page when the Leave group dialog closed under the user')


def open_annika_safety_number(page):
    open_conversation(page, 'dm-annika')
    page.wait_for('[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "View Safety Number")')
    click_text(page, 'button', 'View Safety Number')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Mark as verified")')


@journey()
def marking_verified_keeps_focus_in_the_safety_number_dialog(page):
    """Verify Safety Number open on Annika (whose key changed), Mark as verified: the dialog stays and focus stays inside it, on its button, not on the page."""
    open_annika_safety_number(page)
    click_text(page, '[role=dialog] button', 'Mark as verified')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Clear verification")')
    quiet(page)
    page.expect('document.activeElement?.closest("[role=dialog]") !== null', 'focus left the dialog when the safety number was marked verified')


@journey()
def verified_safety_number_stops_saying_it_is_not_approved(page):
    """Annika's new key is untrusted, so the viewer says it is not approved yet; once marked verified it must not still say messages don't go through until you mark it verified."""
    open_annika_safety_number(page)
    page.expect('/isn.t approved yet/.test(document.querySelector("[role=dialog]").textContent)', 'an untrusted key does not say so')
    click_text(page, '[role=dialog] button', 'Mark as verified')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Clear verification")')
    quiet(page)
    page.expect('!/isn.t approved yet/.test(document.querySelector("[role=dialog]").textContent)', 'the viewer still says the verified key is not approved')


@journey()
def unblocking_in_settings_keeps_focus_inside_settings(page):
    """A chat blocked from its row menu; Settings > Privacy, Unblock and confirm: the entry goes and Settings stays open, so focus stays inside it, not on a row of the list behind it."""
    conversation = open_conversation(page, 'dm-priya')
    open_menu(page, f'[data-conversation-id="{conversation}"]')
    click_menu_item(page, 'Block')
    page.wait_for('!!document.querySelector("[role=alertdialog], [role=dialog]")')
    click_text(page, '[role=alertdialog] button, [role=dialog] button', 'Block')
    page.wait_for(f'document.querySelector({REQUEST_BAR!r})?.getAttribute("data-state") === "blocked"')
    page.key(',', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    click_text(page, '[role=dialog] button', 'Privacy & security')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => /^Unblock/.test(b.getAttribute("aria-label") || ""))')
    page.eval('([...document.querySelectorAll("[role=dialog] button")].find((b) => /^Unblock/.test(b.getAttribute("aria-label") || "")).focus(), 1)')
    page.key('Enter')
    page.wait_for('!!document.querySelector("[role=alertdialog]") || document.querySelectorAll("[role=dialog]").length > 1')
    page.key('Enter')
    page.wait_for(f'!!document.querySelector({COMPOSER!r})')
    quiet(page)
    page.expect('!!document.querySelector("[role=dialog]")', 'Settings closed')
    page.expect('document.activeElement?.closest("[role=dialog]") !== null', 'focus left Settings for the list behind it after Unblock')


def open_settings_page(page, name):
    page.key(',', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog] nav")')
    click_text(page, '[role=dialog] nav button', name)
    quiet(page)


def focus_button(page, text):
    """Focuses the dialog button whose text is `text`, as Tab would."""
    page.eval(f'const b = [...document.querySelectorAll("[role=dialog] button")].find((e) => e.textContent.trim() === {text!r}); b.scrollIntoView(); b.focus(); return 1')


@journey()
def reset_all_keybinds_keeps_focus_off_the_page(page):
    """Settings > Keybinds with one shortcut changed: Reset all (from the keyboard) leaves nothing to reset, so the button goes inert; focus must stay in Settings, not fall to the page (M15, a working button keeps focus)."""
    open_settings_page(page, 'Keybinds')
    page.eval('const b = document.querySelector("[aria-label^=\\"Shortcut for Open settings:\\"]"); b.scrollIntoView(); b.focus(); return 1')
    page.key('Enter')
    page.key('j', ['ctrl', 'alt'])
    page.wait_for('!!document.querySelector("[aria-label=\\"Reset Open settings to default\\"]")')
    focus_button(page, 'Reset all')
    page.key('Enter')
    page.wait_for('!document.querySelector("[aria-label=\\"Reset Open settings to default\\"]")')
    quiet(page)
    page.expect('document.activeElement !== document.body', 'focus fell to the page when Reset all had nothing left to reset')


@journey()
def saving_the_profile_keeps_focus_off_the_page(page):
    """Settings > My profile, a field edited, Save from the keyboard: the draft is clean again, so Save goes inert; focus must stay in Settings, not fall to the page (M15)."""
    open_settings_page(page, 'My profile')
    page.eval('const f = [...document.querySelectorAll("[role=dialog] input")].find((i) => i.getAttribute("aria-label") !== "Search settings" && i.type === "text"); f.focus(); return 1')
    page.type('x')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Save" && !b.disabled)')
    focus_button(page, 'Save')
    page.key('Enter')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Save" && (b.disabled || b.getAttribute("aria-disabled") === "true"))')
    quiet(page)
    page.expect('document.activeElement !== document.body', 'focus fell to the page when Save had nothing left to save')


@journey()
def resetting_plugin_settings_keeps_focus_off_the_page(page):
    """A plugin's settings dialog (over Settings > Plugins) with a setting changed: Reset to defaults from the keyboard leaves nothing customised, so the button goes inert; focus must stay in the dialog, not fall to the page (M15)."""
    open_settings_page(page, 'Plugins')
    page.eval('const b = document.querySelector("[role=dialog] button[aria-label=\\"Clear URLs settings\\"]"); b.scrollIntoView(); b.focus(); return 1')
    page.key('Enter')
    page.wait_for('[...document.querySelectorAll("[role=dialog]")].some((d) => d.textContent.includes("Reset to defaults"))')
    quiet(page)
    page.eval('const d = [...document.querySelectorAll("[data-modal-dialog][data-state=open]")].pop(); d.querySelector("input").focus(); return 1')
    page.key(' ')
    page.wait_for('[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Reset to defaults") && !b.disabled)')
    page.eval('const b = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("Reset to defaults")); b.focus(); return 1')
    page.key('Enter')
    page.wait_for('[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Reset to defaults") && (b.disabled || b.getAttribute("aria-disabled") === "true"))')
    quiet(page)
    page.expect('document.activeElement !== document.body', 'focus fell to the page when Reset to defaults had nothing left to reset')


@journey()
def dialog_opened_over_a_dropdown_menu_leaves_no_menu_open_behind_focus(page):
    """The composer's More options menu is open and Ctrl+K opens the switcher over it: the menu closes first, as a context menu does; Esc on the switcher returns focus to More options with no menu open."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.eval('const b = document.querySelector("[data-snowdrop=composer-input]").closest("form, [data-snowdrop=composer]").querySelector("button[aria-label=\\"More options\\"]"); b.focus(); return 1')
    page.key('Enter')
    page.wait_for('!!document.querySelector("[role=menu]")')
    page.key('k', ['ctrl'])
    page.wait_for('!!document.querySelector("[data-modal-dialog][data-state=open]")')
    quiet(page)
    page.key('Escape')
    page.wait_for('!document.querySelector("[data-modal-dialog][data-state=open]")')
    quiet(page)
    page.expect('!document.querySelector("[role=menu]")', 'a menu is still open behind the dialog')
    page.expect('document.activeElement?.getAttribute("aria-label") === "More options"', 'focus did not return to the menu trigger')


@journey()
def dialog_closing_over_two_drawers_keeps_focus_in_the_top_one(page):
    """Narrow window, navigation drawer open, Ctrl+Shift+M opens the member drawer over it, a member card's Block asks first; Esc on the question: focus must be in the member drawer on top, not in the navigation drawer behind it (M15)."""
    open_conversation(page, 'allotment')
    page.resize(700, 800)
    quiet(page, 10)
    page.eval('const h = document.querySelector("[data-snowdrop=chat-header] button[aria-label^=\\"Open navigation\\"]"); h.focus(); return 1')
    page.key('Enter')
    page.wait_for('!!document.querySelector("[data-snowdrop=drawer]")')
    page.key('M', ['ctrl', 'shift'])
    page.wait_for('!!document.querySelector("[data-snowdrop=member-row]")')
    quiet(page)
    page.eval('const r = document.querySelector("[data-snowdrop=member-row]"); r.setAttribute("data-journey-pick", ""); return 1')
    page.click('[data-journey-pick]')
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Block")')
    click_text(page, '[role=dialog] button', 'Block')
    page.wait_for('!!document.querySelector("[data-modal-dialog][data-state=open]")')
    quiet(page)
    page.key('Escape')
    page.wait_for('!document.querySelector("[data-modal-dialog][data-state=open]")')
    quiet(page)
    page.expect('!document.activeElement?.closest("[data-snowdrop=drawer]")', 'focus went to the navigation drawer behind the member drawer')


@journey()
def a_shortcut_pressed_with_a_dropdown_menu_open_closes_it_and_acts(page):
    """The composer's More options menu is open and Ctrl+F is pressed: the menu closes, then the search panel opens with focus in its field (a global shortcut never acts behind a menu)."""
    open_conversation(page, 'dm-priya')
    page.click(COMPOSER)
    page.eval('const b = document.querySelector("[data-snowdrop=composer-input]").closest("form, [data-snowdrop=composer]").querySelector("button[aria-label=\\"More options\\"]"); b.focus(); return 1')
    page.key('Enter')
    page.wait_for('!!document.querySelector("[role=menu]")')
    page.key('f', ['ctrl'])
    page.wait_for('!document.querySelector("[role=menu]") && document.activeElement?.closest("[data-snowdrop=search-panel]") !== null', 5000)
    quiet(page)
    page.expect('!document.querySelector("[role=menu]") && document.activeElement?.closest("[data-snowdrop=search-panel]") !== null', 'the search panel did not keep focus once the menu closed')


@journey()
def a_keybind_reset_or_conflict_prompt_hands_focus_to_the_recorder(page):
    """Settings > Keybinds: a shortcut changed, then its reset button (it goes once reset), and a shortcut another command has, then Cancel on the prompt (it goes): focus lands on that binding's own shortcut button, not the dialog."""
    open_settings_page(page, 'Keybinds')
    recorder = '[aria-label^=\\"Shortcut for Open settings:\\"]'
    page.eval(f'const b = document.querySelector("{recorder}"); b.scrollIntoView(); b.focus(); return 1')
    page.key('Enter')
    page.key('j', ['ctrl', 'alt'])
    page.wait_for('!!document.querySelector("[aria-label=\\"Reset Open settings to default\\"]")')
    page.eval('const b = document.querySelector("[aria-label=\\"Reset Open settings to default\\"]"); b.focus(); return 1')
    page.key('Enter')
    page.wait_for('!document.querySelector("[aria-label=\\"Reset Open settings to default\\"]")')
    quiet(page)
    page.expect(f'document.activeElement === document.querySelector("{recorder}")', 'focus did not land on the shortcut button after its reset went')
    page.key('Enter')
    page.key('k', ['ctrl'])
    page.wait_for('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Cancel")')
    focus_button(page, 'Cancel')
    page.key('Enter')
    page.wait_for('![...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Cancel")')
    quiet(page)
    page.expect(f'document.activeElement === document.querySelector("{recorder}")', 'focus did not land on the shortcut button after the prompt went')


@journey()
def a_member_menus_profile_item_moves_focus_into_the_card(page):
    """A member's context menu, Profile: the card opens with focus inside it, as it does from a click or Enter on the row (not back on the row)."""
    group_details(page, 'allotment')
    open_menu(page, '[data-snowdrop=member-row]')
    click_menu_item(page, 'Profile')
    page.wait_for('!!document.querySelector("[role=dialog][aria-label$=\\"profile\\"]")')
    quiet(page)
    page.expect('!!document.activeElement?.closest("[role=dialog][aria-label$=\\"profile\\"]")', 'focus is not in the profile card')


@journey()
def the_shortcut_recorder_refuses_a_plain_enter_key(page):
    """Settings > Keybinds: recording Enter for a command that is global is refused with a short message and changes nothing (it would stop buttons activating)."""
    open_settings_page(page, 'Keybinds')
    recorder = '[aria-label^=\\"Shortcut for Open settings:\\"]'
    page.eval(f'const b = document.querySelector("{recorder}"); b.scrollIntoView(); b.focus(); return 1')
    page.key('Enter')
    page.key('Enter')
    page.wait_for('document.querySelector("[role=dialog]").textContent.includes("Enter, Space and plain keys")')
    page.expect('!document.querySelector("[aria-label=\\"Reset Open settings to default\\"]")', 'Enter was recorded as the shortcut')
