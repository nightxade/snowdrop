"""
Randomised user journeys that check invariants (see docs/ARCHITECTURE.md, Testing, Journeys).

A seeded random walk of real user actions (clicks, keys, wheel, resizes) interleaved with
live events (arrivals, receipts, typing, a catch-up with backlog) against the demo world.
After every step the invariants below are checked; a failure reports the seed, the step
and the last actions, and saves a screenshot. A run is replayed with the same seed and step
count (`--fuzz --seed N --steps M`); the walk is deterministic apart from timing.

Invariants (all read from the DOM and `__journey.state()`):
  - the page reports no error;
  - after a keyboard action, focus is not on <body>, apart from the two recorded bugs (a chat
    opened for the first time by Alt+Up/Down or by the switcher's Enter);
  - scrolled up, an arrival leaves the anchor message where it was; at the bottom the
    newest message ends up in view; a sent message ends up in view;
  - once the sidebar is idle each preview is the one the newest message calls for
    (`previewText`); during a catch-up every preview reads "Loading…" and the order holds;
  - a row's unread marker and mention badge agree with the stores (`attentionOf`); a chat
    that got an arrival while it was not open (or scrolled up) shows unread; the open chat
    at the bottom has nothing unread;
  - exactly one sidebar row is selected, it is the open chat, and the header names it (wide: the
    rows are on screen; narrow: they are in the drawer, and the header offers "Open navigation");
  - at most one message is `data-current`, and it is a message of the list;
  - at most one row flashes after a jump; and, with no menu or dialog open, at most one row shows
    hover styling, plus the one that has keyboard focus (DECISIONS C13);
  - Enter on a message steps into it (focus inside the row) and Esc steps out (back on it); the
    menu keys (Shift+F10, Menu, Ctrl+Enter) open its menu and Esc closes it with focus back on it
    (M9, M15);
  - Esc from the composer lands on a message; a closed dialog gives focus back to its opener
    (what had focus before it when it had none, else the composer);
  - the composer holds the draft of the open chat (what was typed and not sent) and is
    empty after a send.
"""
import json
import random
import re
import time

from common import COMPOSER, JUMP_PILL, LAST_MESSAGE, MESSAGE, SCROLLER
from harness import ExpectationFailed, JourneyFailure, pump

NEW_MESSAGE = '[data-snowdrop=sidebar-header] button[aria-label="New message"]'
SETTINGS = '[data-snowdrop=user-panel] button[aria-label="Settings"]'
HOVER_REPLY = '[data-snowdrop=hover-bar] button[aria-label^="Reply"]'
HOVER_DELETE = '[data-snowdrop=hover-bar] button[aria-label^="Delete"]'
WIDTHS = {'wide': 1280, 'medium': 900, 'narrow': 700}  # narrow is under the drawer breakpoint (760)
DRAWER_BELOW = 760  # DECISIONS S20
MAX_NARROW_STEPS = 3  # the walk goes back to a wide window after this many steps (most steps are wide)
OPEN_NAV = '[data-snowdrop=chat-header] button[aria-label^="Open navigation"]'
DELETED_LINE = 'You deleted this message'

# How long a state that is only eventually right (a preview, a badge) may stay wrong.
CONVERGE_S = 3.0

# Snapshot of everything the invariants and the action choice read, in one round trip.
SNAP = f"""(() => {{
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const scroller = q({SCROLLER!r});
  const composer = q({COMPOSER!r});
  const ae = document.activeElement;
  const visible = (e) => {{ const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }};
  const rows = qa('[data-snowdrop=conversation-row]').filter(visible).map((r) => {{
    const b = r.querySelector('[data-conversation-id]');
    const box = b.getBoundingClientRect();
    return {{
      id: b.getAttribute('data-conversation-id'),
      selected: r.hasAttribute('data-selected'),
      unread: r.hasAttribute('data-unread'),
      home: r.getAttribute('data-variant') === 'home',
      special: r.hasAttribute('data-request') || r.hasAttribute('data-blocked'),
      typing: !!r.querySelector('[data-typing]'),
      preview: r.querySelector('[class*="_previewText_"]')?.textContent ?? '',
      badge: r.querySelector('[data-variant=mention]')?.textContent ?? '',
      onscreen: box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth,
    }};
  }});
  const messages = qa({MESSAGE!r});
  const sr = scroller ? scroller.getBoundingClientRect() : null;
  const inView = messages.filter((m) => {{ const r = m.getBoundingClientRect(); return sr && r.top >= sr.top && r.bottom <= sr.bottom; }});
  const current = qa('[data-current]');
  const log = q('[data-snowdrop=message-log]');
  const dialogs = qa('[role=dialog], [role=alertdialog]').filter(visible);
  return {{
    prevBody: window.__fz_prev === document.body,
    prevGone: !!window.__fz_prev && !document.contains(window.__fz_prev),
    prevMessage: !!window.__fz_prev && window.__fz_prev.matches && window.__fz_prev.matches('[data-snowdrop=message]'),
    st: window.__journey.state(),
    rows,
    width: window.innerWidth,
    archiveOpen: !!q('nav[aria-label="Archived chats"]'),
    navButton: !!q({OPEN_NAV!r}) && visible(q({OPEN_NAV!r})),
    navDrawer: qa('[data-snowdrop=drawer]').some(visible),
    hadOpener: !!window.__fz_opener,
    prevId: window.__fz_prev?.getAttribute?.('data-message-id') ?? null,
    activeId: ae?.getAttribute?.('data-message-id') ?? null,
    prevPane: !!window.__fz_prevPane,
    prevReal: !!window.__fz_prev && window.__fz_prev !== document.body,
    newButton: !!q({NEW_MESSAGE!r}) && visible(q({NEW_MESSAGE!r})),
    settingsButton: !!q({SETTINGS!r}) && visible(q({SETTINGS!r})),
    header: q('[data-snowdrop=chat-header] h1')?.textContent.trim() ?? null,
    dist: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null,
    slack: scroller ? Math.max(120, Math.round(scroller.clientHeight / 2)) : 120,
    pill: !!q({JUMP_PILL!r}),
    messageCount: messages.length,
    inView: inView.map((m) => m.getAttribute('data-message-id')),
    allIds: messages.map((m) => m.getAttribute('data-message-id')),
    pending: qa('[data-pending]').length,
    current: current.length,
    hoverRows: qa('[data-message-active]').length,
    flashRows: qa('[data-flash]').length,
    openMenus: qa('[role=menu]').length,
    currentOk: current.every((e) => e.matches('[data-snowdrop=message]') && !!scroller && scroller.contains(e)),
    composer: composer ? composer.value : null,
    selection: composer ? [composer.selectionStart, composer.selectionEnd] : null,
    replying: !!q('[data-snowdrop=reply-bar]'),
    editing: !!q('[data-snowdrop=message] textarea'),
    dialogs: dialogs.length,
    menus: qa('[role=menu], [role=listbox], [data-radix-popper-content-wrapper]').filter(visible).length,
    active: ae ? {{
      body: ae === document.body || ae === document.documentElement,
      composer: ae === composer,
      row: ae.matches('[data-conversation-id]'),
      message: ae.matches('[data-snowdrop=message]'),
      tag: ae.tagName + (ae.getAttribute('data-snowdrop') ? '[' + ae.getAttribute('data-snowdrop') + ']' : ''),
      scroller: ae.matches('[data-virtuoso-scroller]'),
      inList: !!log && log.contains(ae),
      hoverBar: !!ae.closest('[data-snowdrop=hover-bar]'),
      prev: ae === window.__fz_prev,
      opener: ae === window.__fz_opener,
    }} : {{ body: true }},
  }};
}})()"""

PICK_ANCHOR = f"""(() => {{
  const s = document.querySelector({SCROLLER!r}).getBoundingClientRect();
  const mid = s.top + s.height / 2;
  const rows = [...document.querySelectorAll({MESSAGE!r})];
  rows.sort((a, b) => Math.abs(a.getBoundingClientRect().top - mid) - Math.abs(b.getBoundingClientRect().top - mid));
  return rows[0].getAttribute('data-message-id');
}})()"""

NEWEST_IN_VIEW = f"""(() => {{
  const m = {LAST_MESSAGE};
  const s = document.querySelector({SCROLLER!r});
  if (!m || !s) return false;
  const a = m.getBoundingClientRect(), b = s.getBoundingClientRect();
  return a.top >= b.top - 2 && a.bottom <= b.bottom + 2;
}})()"""


def top_of(message_id):
    return f'document.querySelector(\'[data-message-id="{message_id}"]\')?.getBoundingClientRect().top'


class FuzzFailure(ExpectationFailed):
    """An invariant did not hold (or the page misbehaved) during a fuzz run."""


class Fuzzer:
    def __init__(self, page, seed, steps):
        self.page = page
        self.seed = seed
        self.steps = steps
        self.rng = random.Random(seed)
        self.log = []
        self.step_no = 0
        self.counter = 0
        self.drafts = {}  # conversation id -> what the composer should hold
        self.unseen = set()  # conversation ids that got an arrival nobody has seen (not muted)
        self.catch_up_left = 0  # steps until the open catch-up is ended
        self.frozen_order = None
        self.typing_on = {}  # key -> bool
        self.snap_ = None
        self.keyboard = False  # the current action used the keyboard
        self.visited = set()  # chats opened so far
        self.skips = {}  # reason -> how many times an action found nothing to do
        self.narrow_steps = 0
        self.opened_editors = set()  # message ids whose inline editor was opened in this walk
        self.walked = {}  # action name -> times run
        self.last_composer_click = 0.0

    # ------------------------------------------------------------ plumbing

    def say(self, text):
        self.log.append(f'{self.step_no:>4}: {text}')

    def fail(self, why):
        tail = '\n'.join('        ' + line for line in self.log[-20:])
        raise FuzzFailure(
            f'fuzz seed {self.seed}, step {self.step_no} of {self.steps}: {why}\n'
            f'      last actions (replay: --fuzz --seed {self.seed} --steps {self.step_no}):\n{tail}'
        )

    def skip(self, why):
        """An action that found nothing to do: shown in the step log and counted, never silent."""
        self.say(f'SKIPPED: {why}')
        self.skips[why] = self.skips.get(why, 0) + 1

    def show(self, text):
        """A preview for a failure message: only the fuzzer's own synthetic text is quoted."""
        own = {'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'q', 'r'}
        words = [w for w in re.split(r'[^a-zA-Z0-9]+', text) if w]
        only_ours = bool(words) and all(w in own or w.startswith(f'fz{self.seed}n') or re.fullmatch(r'\d+', w) for w in words)
        return repr(text) if only_ours else f'<{len(text)} chars of demo text>'

    def snap(self):
        self.snap_ = self.page.eval(SNAP)
        return self.snap_

    def body(self):
        self.counter += 1
        return f'fz{self.seed}n{self.counter}'

    def send_refused(self, snap):
        """The open chat is one the demo refuses to send to (an unapproved key): by design, and the app logs it."""
        return any(c['id'] == snap['st']['selected'] and c['sendRefused'] for c in snap['st']['conversations'])

    def selected(self):
        return self.snap_['st']['selected']

    def key_of(self, conversation_id):
        for c in self.snap_['st']['conversations']:
            if c['id'] == conversation_id:
                return c['key']
        return None

    def settle(self, ms=120):
        pump(ms)

    # ------------------------------------------------------------ the walk

    def run(self):
        page = self.page
        page.eval('__journey.caughtUp()')  # the held demo catch-up ends; later ones are the fuzzer's
        page.wait_for('!__journey.state().catchingUp', 8000)
        self.snap()
        self.say('open a conversation (setup)')
        self.open_click(first=True)
        for n in range(1, self.steps + 1):
            self.step_no = n
            try:
                self.one_step()
            except FuzzFailure:
                raise
            except JourneyFailure as e:
                self.fail(f'the harness or page failed: {e}')
            except Exception as e:  # noqa: BLE001 - any error in an action or a check is this seed's failure
                self.fail(f'the fuzzer raised {e.__class__.__name__}: {e}')

    def one_step(self):
        snap = self.snap()
        if snap['dialogs'] or snap['menus'] or snap['editing']:
            self.say('Escape (clean up a leftover dialog, menu or editor)')
            self.page.key('Escape')
            self.settle(200)
            snap = self.snap()
        if snap['width'] < DRAWER_BELOW:
            self.narrow_steps += 1
            if self.narrow_steps > MAX_NARROW_STEPS:
                self.say('resize the window to wide (1280px) (the walk does not stay narrow)')
                self.page.resize(WIDTHS['wide'], 800)
                self.settle(300)
                snap = self.snap()
        else:
            self.narrow_steps = 0
        if snap['active'].get('body'):
            # Focus was lost earlier (and checked then). Put it back with a click, as a user would, so that
            # this action starts like any other; nothing is exempted from the checks because of it.
            target = COMPOSER if snap['composer'] is not None else None
            if target is None and snap['rows']:
                target = '[data-conversation-id="' + snap['rows'][0]['id'] + '"]'
            if target is not None:
                self.say('(focus was on <body>: clicking back in)')
                if target == COMPOSER:
                    self.focus_composer()
                else:
                    self.page.click(target)
                self.settle(150)
                snap = self.snap()
        if self.catch_up_left > 0:
            self.catch_up_left -= 1
            if self.catch_up_left == 0:
                self.say('event: caught up')
                self.page.eval('__journey.caughtUp()')
                self.page.wait_for('!__journey.state().catchingUp', 8000)
                self.frozen_order = None
                self.settle(400)  # the sidebar re-sorts when the catch-up ends; the action reads the state after that
                snap = self.snap()
        if snap['st']['selected'] is not None:
            self.visited.add(snap['st']['selected'])
        a = snap['active']
        self.focus_before = next((k for k in ('body', 'composer', 'row', 'message') if a.get(k)), 'other') + f', {snap["width"]}px wide'
        actions = [(w, name) for w, name, ok in self.table() if ok(snap)]
        name = self.rng.choices([a[1] for a in actions], [a[0] for a in actions])[0]
        self.keyboard = False
        self.log_len = len(self.log)
        self.walked[name] = self.walked.get(name, 0) + 1
        getattr(self, name)()
        if len(self.log) > self.log_len:
            self.log[self.log_len] += f'   [focus was: {self.focus_before}]'
        self.settle(150)
        self.check()

    def table(self):
        has_rows = lambda s: len(s['rows']) > 1 and any(r['onscreen'] for r in s['rows'])
        has_chat = lambda s: s['st']['selected'] is not None and s['composer'] is not None
        has_msgs = lambda s: has_chat(s) and s['messageCount'] > 0
        not_busy = lambda s: s['pending'] == 0 and not self.send_refused(s)
        return [
            (6, 'open_click', has_rows),
            (24, 'leave_request', lambda s: s['st']['selected'] is not None and s['composer'] is None and has_rows(s)),  # a message request has no composer, so most actions are unavailable
            (4, 'open_alt', lambda s: s['st']['selected'] is not None),
            (2, 'open_switcher', lambda s: has_chat(s)),
            (5, 'scroll_list', has_msgs),
            (3, 'jump_bottom', lambda s: has_msgs(s) and (s['pill'] or (s['dist'] or 0) > 3)),
            (7, 'send', lambda s: has_chat(s) and not_busy(s)),
            (3, 'type_draft', lambda s: has_chat(s)),
            (2, 'type_to_focus', lambda s: has_msgs(s)),
            (3, 'reply_key', lambda s: has_msgs(s) and not_busy(s)),
            (2, 'reply_hover', lambda s: has_msgs(s) and not_busy(s)),
            (3, 'edit_last', lambda s: has_chat(s) and not_busy(s) and not self.drafts.get(s['st']['selected'])),
            (2, 'react_open', lambda s: has_msgs(s)),
            (3, 'row_keys', lambda s: has_msgs(s) and not_busy(s)),
            (3, 'hover_then_keys', lambda s: has_msgs(s) and s['inView'] != []),
            (2, 'delete_key', lambda s: has_msgs(s) and not_busy(s)),
            (1, 'delete_shift_click', lambda s: has_msgs(s) and not_busy(s)),
            (3, 'esc_composer', lambda s: has_chat(s)),
            (3, 'list_arrows', lambda s: s['active'].get('row', False)),
            (3, 'dialog_settings', lambda s: has_chat(s)),
            (3, 'dialog_new_message', lambda s: has_chat(s)),
            (2, 'resize', lambda s: True),
            (5, 'leave_archive', lambda s: s['archiveOpen']),
            (30, 'drawer_pick', lambda s: s['width'] < DRAWER_BELOW and s['st']['selected'] is not None and s['navButton']),  # a message request has no composer
            (8, 'arrive_open', lambda s: has_chat(s) and s['messageCount'] > 0),
            (6, 'arrive_other', lambda s: has_chat(s)),
            (2, 'receipt', lambda s: has_chat(s)),
            (2, 'typing', lambda s: has_chat(s)),
            (2, 'catch_up', lambda s: self.catch_up_left == 0 and has_chat(s)),
        ]

    # ------------------------------------------------------------ user actions

    def row_ids(self, onscreen=True):
        return [r['id'] for r in self.snap_['rows'] if r['onscreen'] or not onscreen]

    def open_click(self, first=False):
        snap = self.snap_
        choices = [r['id'] for r in snap['rows'] if r['onscreen'] and not r['selected']]
        if not choices:
            self.skip('no other sidebar row on screen to click')
            return
        target = choices[0] if first else self.rng.choice(choices)
        index = [r['id'] for r in snap['rows']].index(target)
        self.say(f'click sidebar row #{index}')
        self.page.click(f'[data-conversation-id="{target}"]')
        self.after_open()

    def leave_request(self):
        self.open_click()

    def after_open(self):
        # A message request has no composer until it is accepted.
        self.page.wait_for(f'!!document.querySelector({COMPOSER!r}) || !!document.querySelector("[data-snowdrop=message-request]")', 5000)
        self.settle(250)
        self.unseen.discard(self.snap()['st']['selected'])

    def open_alt(self):
        direction = self.rng.choice(['ArrowUp', 'ArrowDown'])
        self.say(f'Alt+{direction}')
        self.keyboard = True
        not_from_row = not self.snap_['active']['row']
        self.page.key(direction, ['alt'])
        self.settle(300)
        now = self.snap()['st']['selected']
        self.say(f'  moved to {"a chat opened before" if now in self.visited else "a chat not opened before"}'
                 f' (from {"elsewhere" if not_from_row else "a row"})')
        if now is not None:
            self.unseen.discard(now)

    def open_switcher(self):
        snap = self.snap_
        titles = [c['title'] for c in snap['st']['conversations']]
        word = ''.join(ch for ch in self.rng.choice(titles).lower() if ch.isalpha())[:3] or 'a'
        end = self.rng.choice(['Enter', 'Escape'])
        self.say(f'Ctrl+K, type a 3 letter prefix of a title, {end}')
        self.keyboard = True
        self.page.eval('(window.__fz_prev = document.activeElement, window.__fz_prevPane = !!document.activeElement?.closest?.(\'[data-snowdrop=message-pane]\'), window.__fz_opener = null, true)')
        self.page.key('k', ['ctrl'])
        self.page.wait_for('!!document.querySelector("[role=dialog]")', 4000)
        self.page.type(word)
        self.page.key(end)
        self.dialog_closed(end == 'Enter')

    def dialog_closed(self, may_open_chat=False):
        """Waits for the dialog to go away (pressing Esc once more when Enter left it open)."""
        if not pump_wait(self.page, '!document.querySelector("[role=dialog]")', 1500):
            self.say('Escape (the dialog was still open)')
            self.page.key('Escape')
            self.page.wait_for('!document.querySelector("[role=dialog]")', 4000)
        self.settle(300)
        snap = self.snap()
        a = snap['active']
        if snap['hadOpener']:
            ok = a['opener']  # M15: the opener gets focus back (a chat opened by Enter takes the message list)
            where = 'its opener'
        elif snap['prevReal']:
            # What had focus before it, or (when a re-render replaced that message row) the message list again.
            ok = a['prev'] or (snap['prevGone'] and snap['prevPane'] and (a['message'] or a['scroller']))
            where = 'what had focus before it'
            where += f' (prev gone: {snap["prevGone"]}, a message: {snap["prevMessage"]}; same message id: {snap["prevId"] is not None and snap["prevId"] == snap["activeId"]})'
        else:
            ok = a['composer'] or a['opener']
            where = 'the composer (nothing had focus before it)'
        if may_open_chat and (a['message'] or a['row'] or a['scroller']):
            ok = True
        if not ok:
            self.fail(f'after a dialog closed, focus was not on {where} (it is on {a["tag"]})')
        if snap['st']['selected'] is not None:
            self.unseen.discard(snap['st']['selected'])

    def scroll_list(self):
        dy = self.rng.choice([-1, 1]) * self.rng.choice([150, 400, 900])
        self.say(f'wheel {"up" if dy < 0 else "down"} {abs(dy)}px over the message list')
        self.page.scroll(SCROLLER, dy)

    def jump_bottom(self):
        if self.snap_['pill'] and self.rng.random() < 0.6:
            self.say('click the jump to present pill')
            self.page.click(JUMP_PILL)
        else:
            self.say('Shift+PageDown (jump to latest)')
            self.keyboard = True
            self.page.key('PageDown', ['shift'])
        if not pump_wait(self.page, 'document.querySelector(' + json.dumps(SCROLLER) + ').scrollHeight - document.querySelector(' + json.dumps(SCROLLER) + ').scrollTop - document.querySelector(' + json.dumps(SCROLLER) + ').clientHeight < 3', 4000):
            self.fail('jumping to the bottom did not reach the bottom')

    def focus_composer(self):
        # Two clicks inside the double-click time select a word of the draft (and the next key replaces it):
        # that is how a double click works, so a user's second click comes later than that.
        wait = 0.7 - (time.monotonic() - self.last_composer_click)
        if wait > 0:
            pump(int(wait * 1000))
        self.page.click(COMPOSER)
        self.last_composer_click = time.monotonic()

    def send(self):
        conversation = self.selected()
        text = self.body()
        self.say('click the composer, type a message, Enter')
        self.keyboard = True
        self.focus_composer()
        self.page.type(text)
        self.page.key('Enter')
        self.drafts[conversation] = ''
        self.sent_check(text)

    def sent_check(self, text):
        if not pump_wait(self.page, f'{LAST_MESSAGE}?.textContent.includes({text!r}) && {LAST_MESSAGE}.hasAttribute("data-pending") === false', 8000):
            self.fail('a sent message did not show up as the newest one')
        if not pump_wait(self.page, NEWEST_IN_VIEW, 3000):
            self.fail('the message just sent is not in view')

    def type_draft(self):
        text = self.rng.choice(['alpha', 'bravo charlie', 'delta', 'echo foxtrot golf'])
        conversation = self.selected()
        self.say('click the composer, type a draft (not sent)')
        self.keyboard = True
        self.focus_composer()
        snap = self.snap()
        before = snap['composer']
        if before != self.drafts.get(conversation, ''):
            self.fail('the composer did not hold the draft of this chat before typing')
        start, end = snap['selection']  # where the click put the caret: the text goes there
        expected = before[:start] + text + before[end:]
        self.page.type(text)
        pump_wait(self.page, f'document.querySelector({COMPOSER!r}).value === {json.dumps(expected)}', 1500)
        after = self.snap()['composer']
        if after != expected:
            self.fail(self.draft_mismatch('the composer does not hold what was typed', before, text, after))
        self.drafts[conversation] = after

    def draft_mismatch(self, what, before, typed, after):
        """What the composer holds against what it should: only the fuzzer's own text is quoted."""
        return (
            f'{what} (before {self.show(before)} [{len(before)} chars], typed {typed!r}, '
            f'holds {self.show(after)} [{len(after)} chars], expected {len(before) + len(typed)} chars; '
            f'draft kept for this chat: {self.show(self.drafts.get(self.selected(), ""))}; focus {self.snap_["active"]["tag"]})'
        )

    def press_escape_in_composer(self):
        """Esc with the composer focused. KEYBOARD.md: it marks the chat read only when the composer is empty
        (after the suggestions and a pending reply have taken their Esc) and the chat is unread."""
        snap = self.snap()
        chat = next((c for c in snap['st']['conversations'] if c['id'] == snap['st']['selected']), None)
        marks_read = snap['composer'] == '' and not snap['replying'] and chat is not None and chat['hasUnread']
        self.page.key('Escape')
        if marks_read:
            self.unseen.discard(snap['st']['selected'])

    def leave_composer(self):
        """Focus the composer, press Esc (twice when a reply was pending): focus must land on a message."""
        self.focus_composer()
        self.keyboard = True
        for _ in range(2):
            self.press_escape_in_composer()
            self.settle(250)
            if not self.snap()['active']['composer']:
                break
        if not pump_wait(self.page, 'document.activeElement?.matches("[data-snowdrop=message]")', 2000):
            self.fail('Esc from the composer did not land on a message')

    def esc_composer(self):
        self.say('click the composer, Esc (and Esc again if still there)')
        if self.snap_['messageCount'] == 0:
            self.focus_composer()
            self.press_escape_in_composer()
            return
        self.leave_composer()

    def type_to_focus(self):
        self.say('Esc to the message list, then type a letter (starts a message)')
        conversation = self.selected()
        self.leave_composer()
        snap = self.snap()
        before = snap['composer']
        start, end = snap['selection']  # a letter typed on the list lands where the caret was left
        expected = before[:start] + 'q' + before[end:]
        self.page.type('q')
        if not pump_wait(self.page, f'document.activeElement === document.querySelector({COMPOSER!r})', 1500):
            self.fail('typing a letter on the message list did not move it to the composer')
        after = self.snap()['composer']
        if after != expected:
            self.fail(self.draft_mismatch(f'the typed letter did not reach the composer (caret was at {start}-{end})', before, 'q', after))
        self.drafts[conversation] = after

    def reply_key(self):
        self.say('Esc to the list, arrows, R, type, Enter')
        self.leave_composer()
        for _ in range(self.rng.choice([0, 1, 2])):
            self.page.key(self.rng.choice(['ArrowUp', 'ArrowUp', 'ArrowDown']))
        conversation = self.selected()
        before = self.snap()['composer']
        self.page.key('r')
        if not pump_wait(self.page, '!!document.querySelector("[data-snowdrop=reply-bar]")', 1500):
            # Not a reply: the letter starts a message (typing on the list moves to the composer), as for q.
            self.skip('R offered no reply on that message, so the letter went to the composer')
            if not pump_wait(self.page, f'document.querySelector({COMPOSER!r}).value === {json.dumps(before + "r")}', 1500):
                after = self.snap()['composer']
                self.fail(self.draft_mismatch('R on a message without a reply did not leave the letter in the composer', before, 'r', after))
            self.drafts[conversation] = before + 'r'
            return
        if not pump_wait(self.page, f'document.activeElement === document.querySelector({COMPOSER!r})', 1500):
            self.fail('reply did not focus the composer')
        self.finish_reply()

    def finish_reply(self):
        conversation = self.selected()
        text = self.body()
        self.page.type(text)
        self.page.key('Enter')
        self.drafts[conversation] = ''
        self.sent_check(text)

    def reply_hover(self):
        snap = self.snap_
        if not snap['inView']:
            self.skip('no message fully in view to hover')
            return
        target = self.rng.choice(snap['inView'])
        self.say('hover a message, click Reply in the hover bar, type, Enter')
        self.page.hover(f'[data-message-id="{target}"]')
        # The bar to use is the hovered row's own: the current (keyboard) row keeps a bar of its own.
        reply = f'[data-message-id="{target}"] {HOVER_REPLY}'
        if not pump_wait(self.page, f'!!document.querySelector({reply!r})', 1500):
            self.skip('the hover bar showed no Reply button')
            return
        if not self.uncovered(reply):
            self.skip('the Reply button was covered by something else (a bar above the top row)')
            return
        self.page.click(reply)
        if not pump_wait(self.page, '!!document.querySelector("[data-snowdrop=reply-bar]")', 2000):
            self.fail(f'the Reply button did not start a reply (focus on {self.snap()["active"]["tag"]})')
        self.finish_reply()

    def uncovered(self, selector):
        """Whether the element is what is under its own centre (a bar hanging out above the top row can sit under the header)."""
        return self.page.eval(
            f'(() => {{ const e = document.querySelector({selector!r}); if (!e) return false; const r = e.getBoundingClientRect();'
            ' const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && e.contains(t); })()'
        )

    def edit_last(self):
        self.say('click the empty composer, ArrowUp (edit last), type, Enter or Esc')
        self.keyboard = True
        self.focus_composer()
        if self.snap()['composer'] != '':
            self.skip('the composer was not empty, so Up would not edit')
            return
        self.page.key('ArrowUp')
        if not pump_wait(self.page, '!!document.querySelector("[data-snowdrop=message] textarea")', 1200):
            self.skip('Up opened no editor (nothing of yours to edit)')
            return
        edited_id = self.page.eval('document.querySelector("[data-snowdrop=message] textarea").closest("[data-snowdrop=message]")?.getAttribute("data-message-id") ?? null')
        reopened = edited_id in self.opened_editors
        self.opened_editors.add(edited_id)
        if not self.page.eval('document.activeElement?.matches("[data-snowdrop=message] textarea")'):
            self.fail(f'the inline editor opened {"again" if reopened else "for the first time"} without taking focus')
        if self.rng.random() < 0.6:
            text = self.body()
            self.page.type(' ' + text)
            self.page.key('Enter')
            if not pump_wait(self.page, f'!document.querySelector("[data-snowdrop=message] textarea") && [...document.querySelectorAll({MESSAGE!r})].some((m) => m.textContent.includes({text!r}))', 5000):
                still = self.page.eval('!!document.querySelector("[data-snowdrop=message] textarea")')
                self.fail(f'an edit was not saved into the message (editor still open: {still}, focus on {self.snap()["active"]["tag"]})')
        else:
            self.page.key('Escape')
            if not pump_wait(self.page, '!document.querySelector("[data-snowdrop=message] textarea")', 3000):
                self.fail(f'Esc did not close the inline editor (focus on {self.snap()["active"]["tag"]})')

    def wheel_into_view(self, selector):
        """Scrolls the message list with the wheel until the element is inside it, as a user looking for it would
        (a click on an element scrolled out of view lands on something else)."""
        probe = (f'(() => {{ const e = document.querySelector({selector!r}), s = document.querySelector({SCROLLER!r});'
                 ' if (!e || !s) return null; const a = e.getBoundingClientRect(), b = s.getBoundingClientRect();'
                 ' return a.top < b.top ? -1 : a.bottom > b.bottom ? 1 : 0; })()')
        for _ in range(15):
            where = self.page.eval(probe)
            if where is None:
                self.fail('the inline editor vanished while scrolling to it')
            if where == 0:
                return
            self.say(f'  wheel {"up" if where < 0 else "down"} 300px to bring the editor into view')
            self.page.scroll(SCROLLER, where * 300)
            self.settle(150)
        self.fail('could not scroll the inline editor into view')

    def react_open(self):
        self.say('Esc to the list, + (react), Esc')
        self.leave_composer()
        if self.page.eval(f'document.activeElement.textContent.includes({DELETED_LINE!r})'):
            # A deleted message has nothing to react to (the key would just start a message).
            self.skip('the current message is one you deleted: nothing to react to')
            return
        self.page.eval('(window.__fz_prev = document.activeElement, window.__fz_prevPane = !!document.activeElement?.closest?.(\'[data-snowdrop=message-pane]\'), window.__fz_opener = null, true)')
        self.page.key('+')
        self.settle(500)
        snap = self.snap()
        if not (snap['dialogs'] or snap['menus']):
            self.fail('+ on a message did not open the reaction picker')
        self.page.key('Escape')
        self.settle(400)
        snap = self.snap()
        if snap['dialogs'] or snap['menus']:
            self.fail('Esc did not close the reaction picker')
        a = snap['active']
        if not (a['prev'] or a['message'] or a['composer'] or a['hoverBar']):
            self.fail('after the reaction picker closed, focus was not back on the message')

    def row_keys(self):
        """M9 and M15 on a message of the list: Enter steps into it and Esc out; each menu key opens its menu and Esc closes it."""
        self.say('Esc to the list, arrows, then Enter and Esc, or a menu key and Esc')
        self.leave_composer()
        for _ in range(self.rng.choice([0, 1, 2])):
            self.page.key(self.rng.choice(['ArrowUp', 'ArrowDown']))
        target = self.page.eval('document.activeElement.getAttribute("data-message-id")')
        if not target:
            self.skip('focus was not on a message, so its keys had nothing to act on')
            return
        row = f'[data-message-id="{target}"]'
        if self.page.eval(f'document.querySelector({row!r}).textContent.includes({DELETED_LINE!r})'):
            self.skip('the current message is one you deleted: it has no menu to open')
            return
        self.keyboard = True
        on_row = f'document.activeElement === document.querySelector({row!r})'
        # A narrow window is a touch layout: no context menu there (an action sheet by long press instead).
        wide = self.snap()['width'] >= DRAWER_BELOW
        how = self.rng.choice(['Enter', 'Shift+F10', 'Menu', 'Ctrl+Enter'] if wide else ['Enter'])
        self.say(f'on a message: {how}, then Esc')
        if how == 'Enter':
            self.page.key('Enter')
            inside = f'document.querySelector({row!r}).contains(document.activeElement) && !({on_row})'
            if not pump_wait(self.page, inside, 1500):
                controls = self.page.eval(f'!!document.querySelector({row!r}).querySelector("button:not([disabled]), a[href], input, textarea")')
                if controls:
                    self.fail(f'Enter on a message did not step into it (focus on {self.snap()["active"]["tag"]})')
                self.skip('the message has no control to step into')
                return
            self.page.key('Escape')
            if not pump_wait(self.page, on_row, 1500):
                self.fail(f'Esc did not step back out onto the message (focus on {self.snap()["active"]["tag"]})')
            return
        keys = {'Shift+F10': ('F10', ['shift']), 'Menu': ('Menu', []), 'Ctrl+Enter': ('Enter', ['ctrl'])}[how]
        self.page.key(*keys)
        if not pump_wait(self.page, '!!document.querySelector("[role=menu]")', 1500):
            self.fail(f'{how} on a message did not open its menu')
        self.page.key('Escape')
        if not pump_wait(self.page, '!document.querySelector("[role=menu]")', 1500):
            self.fail('Esc did not close the message menu')
        if not pump_wait(self.page, on_row, 1500):
            self.fail(f'closing the message menu did not give focus back to the message (focus on {self.snap()["active"]["tag"]})')

    def hover_then_keys(self):
        """C13: the pointer rests on a message while the keyboard moves the current row about; the walk's check holds the hover styling to its rule."""
        snap = self.snap_
        target = self.rng.choice(snap['inView'])
        self.say('hover a message, then Esc/arrows (the pointer stays where it is)')
        self.page.hover(f'[data-message-id="{target}"]')
        self.keyboard = True
        if self.snap()['active'].get('composer'):
            self.press_escape_in_composer()
            self.settle(250)
        for _ in range(self.rng.choice([1, 2, 3])):
            if not self.snap()['active'].get('message'):
                break
            self.page.key(self.rng.choice(['ArrowUp', 'ArrowDown']))

    def deleted_or_gone(self, target):
        return pump_wait(
            self.page,
            f'(() => {{ const e = document.querySelector(\'[data-message-id="{target}"]\'); return !e || e.textContent.includes({DELETED_LINE!r}); }})()',
            4000,
        )

    def delete_key(self):
        self.say('Esc to the list, arrows, Delete, then Enter or Esc on the dialog')
        self.leave_composer()
        for _ in range(self.rng.choice([0, 1, 2])):
            self.page.key(self.rng.choice(['ArrowUp', 'ArrowDown']))
        target = self.page.eval('document.activeElement.getAttribute("data-message-id")')
        if not target:
            self.skip('focus was not on a message, so Delete had nothing to delete')
            return
        self.page.eval('(window.__fz_prev = document.activeElement, window.__fz_prevPane = !!document.activeElement?.closest?.(\'[data-snowdrop=message-pane]\'), window.__fz_opener = null, true)')
        self.page.key('Delete')
        confirm = self.rng.random() < 0.7
        everyone = False
        if pump_wait(self.page, '!!document.querySelector("[role=alertdialog], [role=dialog]")', 1200):
            everyone = self.page.eval('/everyone/i.test(document.querySelector("[role=alertdialog], [role=dialog]").textContent)')
            self.page.key('Enter' if confirm else 'Escape')
            if not pump_wait(self.page, '!document.querySelector("[role=alertdialog], [role=dialog]")', 4000):
                self.fail('the delete confirmation did not close')
        else:
            confirm = True  # deleted without asking
        self.settle(400)
        if confirm:
            if not self.deleted_or_gone(target):
                self.fail('a confirmed delete left the message as it was (neither gone nor "You deleted this message")')
        elif not self.page.eval(f'!!document.querySelector(\'[data-message-id="{target}"]\') && !document.querySelector(\'[data-message-id="{target}"]\').textContent.includes({DELETED_LINE!r})'):
            self.fail('Esc on the delete confirmation still deleted the message')

    def delete_shift_click(self):
        snap = self.snap_
        if not snap['inView']:
            self.skip('no message fully in view to hover')
            return
        target = self.rng.choice(snap['inView'])
        self.say('hold Shift, hover a message, click Delete in the hover bar (no question), release Shift')
        self.page.key_down('Shift')
        try:
            self.page.hover(f'[data-message-id="{target}"]')
            delete = f'[data-message-id="{target}"] {HOVER_DELETE}'  # the hovered row's own bar
            if not pump_wait(self.page, f'!!document.querySelector({delete!r})', 1500):
                self.skip('the hover bar showed no Delete button')
                return
            if not self.uncovered(delete):
                self.skip('the Delete button was covered by something else (a bar above the top row)')
                return
            self.page.click(delete)
            self.settle(400)
            if self.snap()['dialogs']:
                self.fail('Shift+click on Delete still asked for confirmation')
            if not self.deleted_or_gone(target):
                self.fail('Shift+click on Delete left the message as it was (neither gone nor "You deleted this message")')
        finally:
            self.page.key_up('Shift')

    def list_arrows(self):
        keys = [self.rng.choice(['ArrowUp', 'ArrowDown', 'Home', 'End']) for _ in range(self.rng.choice([1, 2, 3]))]
        self.say('in the sidebar list: ' + ', '.join(keys))
        self.keyboard = True
        for k in keys:
            self.page.key(k)
        self.settle(150)
        if self.rng.random() < 0.4:
            self.say('Enter on the focused row (open it)')
            self.page.key('Enter')
            self.after_open()

    def dialog_settings(self):
        how = self.rng.choice(['click', 'shortcut']) if self.snap_['settingsButton'] else 'shortcut'
        self.say(f'open Settings ({how}), then Esc')
        self.open_dialog(SETTINGS if how == 'click' else None, (',', ['ctrl']) if how == 'shortcut' else None)

    def dialog_new_message(self):
        how = self.rng.choice(['click', 'shortcut']) if self.snap_['newButton'] else 'shortcut'
        close = self.rng.choice(['Escape', 'Escape', 'Enter'])
        self.say(f'open the new message dialog ({how}), then {close}')
        self.open_dialog(NEW_MESSAGE if how == 'click' else None, ('n', ['ctrl']) if how == 'shortcut' else None, close)

    def open_dialog(self, button, shortcut, close='Escape'):
        self.keyboard = True
        self.page.eval(f'(window.__fz_prev = document.activeElement, window.__fz_prevPane = !!document.activeElement?.closest?.(\'[data-snowdrop=message-pane]\'), window.__fz_opener = {("document.querySelector(" + json.dumps(button) + ")") if button else "null"}, true)')
        if button:
            self.page.click(button)
        else:
            self.page.key(*shortcut[:1], shortcut[1])
        if not pump_wait(self.page, '!!document.querySelector("[role=dialog]")', 4000):
            self.fail('the dialog did not open')
        self.settle(300)
        self.page.key(close)
        self.dialog_closed(may_open_chat=close == 'Enter')

    def resize(self):
        name = self.rng.choice(['wide', 'wide', 'wide', 'wide', 'medium', 'medium', 'narrow', 'narrow'])
        self.say(f'resize the window to {name} ({WIDTHS[name]}px)')
        self.page.resize(WIDTHS[name], 800)
        self.settle(300)

    def leave_archive(self):
        self.say('click "Back to conversations" in the archive view')
        self.page.click('nav[aria-label="Archived chats"] button[aria-label="Back to conversations"]')
        self.settle(300)

    def drawer_pick(self):
        """Narrow (S20): open the navigation drawer, check its rows, pick a chat (or the open one again): the drawer closes."""
        again = self.rng.random() < 0.3
        self.say('narrow: click "Open navigation", ' + ('pick the chat that is already open' if again else 'pick another chat'))
        self.page.click(OPEN_NAV)
        if not pump_wait(self.page, '!!document.querySelector("[data-snowdrop=drawer]")', 3000):
            self.fail('"Open navigation" did not open the drawer')
        self.settle(400)
        self.check()  # the rows are on screen now: every sidebar invariant runs on them
        snap = self.snap()
        rows = [r for r in snap['rows'] if r['onscreen']]
        choices = [r for r in rows if r['selected'] == again]
        if not choices:
            self.skip('the drawer showed no row of the kind to pick')
            self.page.key('Escape')
            self.settle(300)
            return
        target = self.rng.choice(choices)['id']
        self.page.click(f'[data-conversation-id="{target}"]')
        self.after_open()
        if not pump_wait(self.page, '!document.querySelector("[data-snowdrop=drawer]")', 3000):
            self.fail('picking a chat in the navigation drawer did not close it')

    # ------------------------------------------------------------ events

    def arrive_open(self):
        snap = self.snap_
        key = self.key_of(snap['st']['selected'])
        count = self.rng.choice([1, 1, 2, 5])
        spacing = self.rng.choice([0, 30, 120])
        dist = snap['dist']
        scrolled = dist is not None and dist > snap['slack'] + 40  # the app follows arrivals within its slack (bottomPin.ts)
        at_bottom = dist is not None and dist < 3
        anchor = before = None
        if scrolled and snap['messageCount'] > 0 and snap['inView']:
            anchor = self.page.eval(PICK_ANCHOR)
            before = self.page.eval(top_of(anchor))
        self.say(f'event: {count} arrival(s) in the open chat, {spacing} ms apart' + (' (scrolled up)' if scrolled else ' (at the bottom)' if at_bottom else ''))
        text = self.body()
        self.page.eval(f'await __journey.deliver({{ conversation: {key!r}, count: {count}, spacingMs: {spacing}, text: {text!r} }})')
        self.settle(400)
        if anchor is not None:
            now = self.page.eval(top_of(anchor))
            if now is None or abs(now - before) > 4:
                self.fail(f'scrolled up, an arrival moved the message in view (by {None if now is None else round(now - before)} px)')
            if not self.page.eval(f'!!document.querySelector({JUMP_PILL!r})'):
                self.say('(note: no jump pill while scrolled up)')
            if not self.key_muted(snap['st']['selected']):
                self.unseen.add(snap['st']['selected'])
        elif at_bottom:
            if not pump_wait(self.page, f'{LAST_MESSAGE}?.textContent.includes("{text} {count}")', 4000):
                self.fail('at the bottom, the newest arrival did not appear in the list')
            if not pump_wait(self.page, NEWEST_IN_VIEW, 3000):
                self.fail('at the bottom, the newest arrival is not in view')

    def key_muted(self, conversation_id):
        return any(c['id'] == conversation_id and c['muted'] for c in self.snap_['st']['conversations'])

    def arrive_other(self):
        snap = self.snap_
        others = [c for c in snap['st']['conversations'] if c['id'] != snap['st']['selected'] and c['key']]
        if not others:
            self.skip('no other chat to deliver to')
            return
        target = self.rng.choice(others)
        count = self.rng.choice([1, 1, 3])
        self.say(f'event: {count} arrival(s) in another chat')
        self.page.eval(f'await __journey.deliver({{ conversation: {target["key"]!r}, count: {count}, spacingMs: 40, text: {self.body()!r} }})')
        if not target['muted']:
            self.unseen.add(target['id'])

    def receipt(self):
        snap = self.snap_
        pool = [c for c in snap['st']['conversations'] if c['key']]
        target = self.rng.choice(pool)
        kind = self.rng.choice(['delivered', 'read'])
        self.say(f'event: a {kind} receipt for a chat')
        self.page.eval(f'__journey.receipt({target["key"]!r}, {kind!r})')

    def typing(self):
        snap = self.snap_
        pool = [c for c in snap['st']['conversations'] if c['key']]
        target = self.rng.choice(pool)
        on = not self.typing_on.get(target['key'], False)
        self.typing_on[target['key']] = on
        self.say(f'event: typing {"starts" if on else "stops"} in a chat')
        self.page.eval(f'__journey.typing({target["key"]!r}, {json.dumps(on)})')

    def catch_up(self):
        snap = self.snap_
        pool = [c for c in snap['st']['conversations'] if c['key']]
        self.catch_up_left = self.rng.choice([3, 5, 8])
        self.frozen_order = [r['id'] for r in snap['rows']]
        self.say(f'event: a catch-up starts (ends in {self.catch_up_left} steps), backlog in 3 chats')
        self.page.eval('__journey.startCatchUp()')
        for target in self.rng.sample(pool, min(3, len(pool))):
            self.page.eval(f'await __journey.deliver({{ conversation: {target["key"]!r}, count: 3, spacingMs: 20, text: {self.body()!r} }})')
            if target['id'] != snap['st']['selected'] and not target['muted']:
                self.unseen.add(target['id'])

    # ------------------------------------------------------------ invariants

    def check(self):
        errors = self.page.page_errors()
        if errors:
            self.fail(f'the page reported errors: {errors[:3]}')
        deadline = time.monotonic() + CONVERGE_S
        while True:
            problems = self.problems(self.snap())
            if not problems:
                return
            if time.monotonic() > deadline:
                self.fail('; '.join(problems))
            pump(120)

    def problems(self, s):
        out = []
        st = s['st']
        rows = s['rows']
        selected_rows = [r for r in rows if r['selected']]
        narrow = s['width'] < DRAWER_BELOW
        if not rows:
            # No row is on screen. Wide, the sidebar is always there. Narrow (S20) it is a drawer: with the
            # drawer shut the chat fills the window and its header offers "Open navigation".
            if not narrow:
                if not s['archiveOpen']:  # an empty archive is a view of the list with no row
                    out.append('no sidebar row is on screen in a wide window')
            elif s['navDrawer']:
                out.append('the navigation drawer is open but shows no row')
            elif st['selected'] is not None and not s['navButton']:
                out.append('narrow: the open chat\'s header has no "Open navigation" button')
        if rows and st['selected'] is not None:
            shown = any(r['id'] == st['selected'] for r in rows)  # the list may show another space or the archive
            if len(selected_rows) != (1 if shown else 0):
                out.append(f'{len(selected_rows)} sidebar rows are selected, expected {1 if shown else 0}')
            elif shown and selected_rows[0]['id'] != st['selected']:
                out.append('the selected sidebar row is not the open chat')
        chat = next((c for c in st['conversations'] if c['id'] == st['selected']), None)
        if chat and s['header'] is not None and not s['header'].endswith(chat['title']):
            out.append('the chat header does not name the open chat')
        if s['current'] > 1:
            out.append(f'{s["current"]} messages are current, expected at most one')
        if s['flashRows'] > 1:
            out.append(f'{s["flashRows"]} messages flash at once, expected at most one')
        if not s['dialogs'] and not s['openMenus'] and not s['menus']:
            # One row is hovered; keyboard focus activates one more (DECISIONS C13).
            allowed = 2 if s['active'].get('inList') else 1
            if s['hoverRows'] > allowed:
                out.append(f'{s["hoverRows"]} message rows show hover styling, expected at most {allowed}')
        if not s['currentOk']:
            out.append('the current message is not a message of the list')
        if self.keyboard and s['active']['body']:
            out.append('focus is on <body> after a keyboard action')
        by_id = {c['id']: c for c in st['conversations']}
        if st['catchingUp']:
            for r in rows:
                if r['home'] and not r['special'] and not r['typing'] and r['preview'] != 'Loading…':
                    out.append('a preview does not read "Loading…" during a catch-up')
                    break
            if not rows:
                # The sidebar is not mounted (narrow, drawer shut): when it mounts again during the catch-up it
                # takes a new snapshot (useFrozenWhile keeps its state in the component), so hold it to that one.
                self.frozen_order = None
            elif self.frozen_order is None:
                self.frozen_order = [r['id'] for r in rows]
            if self.frozen_order is not None:
                now = [r['id'] for r in rows]
                kept = [i for i in self.frozen_order if i in now]
                if now != kept and [i for i in now if i in self.frozen_order] != kept:
                    out.append('the sidebar order changed during a catch-up')
        else:
            for r in rows:
                c = by_id.get(r['id'])
                if c is None:
                    continue
                if r['home'] and not r['special'] and not r['typing'] and r['preview'] != c['expectedPreview']:
                    out.append(f'a sidebar preview does not match its chat\'s newest message (row {rows.index(r)}: shows {self.show(r["preview"])}, expected {self.show(c["expectedPreview"])})')
                    break
            for r in rows:
                c = by_id.get(r['id'])
                if c is None:
                    continue
                if r['unread'] != c['hasUnread']:
                    out.append('a row\'s unread marker disagrees with the stores')
                    break
                if r['badge'] != (str(c['mentions']) if c['mentions'] > 0 else ''):
                    out.append('a row\'s mention badge disagrees with the stores')
                    break
            for cid in list(self.unseen):
                c = by_id.get(cid)
                if c is None or c['muted']:
                    continue
                if cid == st['selected']:
                    if s['dist'] is not None and s['dist'] < 3:
                        self.unseen.discard(cid)  # scrolled back to the bottom: read
                    elif c['unread'] == 0:
                        out.append('arrivals while scrolled up in the open chat are not counted unread')
                elif c['unread'] == 0 and c['mentions'] == 0:
                    out.append('a chat with an arrival nobody has seen shows nothing unread')
            if chat and s['dist'] is not None and s['dist'] < 3 and s['pending'] == 0 and chat['unread'] > 0:
                out.append('the open chat, at the bottom, still has unread messages')
        if st['selected'] is not None and s['composer'] is not None and not s['editing']:
            expected = self.drafts.get(st['selected'], '')
            if s['composer'] != expected:
                out.append(f'the composer does not hold exactly the open chat\'s draft (holds {s["composer"]!r}, typed and not sent: {expected!r})')
        return out


def pump_wait(page, js, timeout_ms):
    """True once the expression holds, False after the timeout (a failure is the caller's to name)."""
    try:
        page.wait_for(js, timeout_ms)
        return True
    except ExpectationFailed:
        return False


def fuzz(page, seed, steps):
    """Runs one walk; returns what it did: how often each action ran and how often one found nothing to do."""
    walker = Fuzzer(page, seed, steps)
    walker.run()
    return {'walked': walker.walked, 'skips': walker.skips}
