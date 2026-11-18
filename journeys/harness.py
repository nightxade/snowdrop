"""
Drives the app in real WebKitGTK (the engine of the desktop build) for user
journeys: real GDK key, pointer and scroll events, in an offscreen window.

Needs only the system PyGObject (Gtk 3, WebKit2 4.1). Nothing here touches the
user's data: every journey gets a fresh webview with an ephemeral data manager.
"""
import functools
import json
import os
import re
import sys
import time

# No GPU or compositor under an offscreen window: render in software, and use
# the X11 backend (XWayland on Wayland desktops), where synthetic input into
# an offscreen window is stable. Must be set before WebKit is imported. These
# are defaults: a value already in the environment wins.
os.environ.setdefault('WEBKIT_DISABLE_COMPOSITING_MODE', '1')
os.environ.setdefault('WEBKIT_DISABLE_DMABUF_RENDERER', '1')
os.environ.setdefault('LIBGL_ALWAYS_SOFTWARE', '1')
os.environ.setdefault('GDK_BACKEND', 'x11')

import gi  # noqa: E402

gi.require_version('Gdk', '3.0')
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402



def require_display():
    """Stops with a clear message when there is no display to open a window on."""
    if Gdk.Display.get_default() is None:
        sys.exit(
            'The journeys need an X display (X11, or XWayland on a Wayland desktop): '
            'DISPLAY is not set or cannot be opened.'
        )


MAIN_CTX = GLib.MainContext.default()

# Reported by browsers for harmless layout feedback loops.
IGNORED_PAGE_ERRORS = ('ResizeObserver loop',)

WIDTH, HEIGHT = 1280, 800
POLL_S = 0.05


def one_line(js, limit=240):
    """One short line of a script, for failure messages."""
    one = ' '.join(js.split())
    return one if len(one) <= limit else one[: limit - 1] + '…'


class JourneyFailure(Exception):
    """A journey failed: an expectation, or the harness or page itself."""


class ExpectationFailed(JourneyFailure):
    """The page was fine, and what the journey expected did not happen (in time)."""


class ScriptThrew(JourneyFailure):
    """A script the journey ran threw."""


def pump(ms):
    """Run the GTK main loop for `ms` (the multi-process WebKit needs it)."""
    end = time.monotonic() + ms / 1000.0
    while time.monotonic() < end:
        if MAIN_CTX.pending():
            MAIN_CTX.iteration(False)
        else:
            time.sleep(0.004)


def pump_until(predicate, timeout_ms):
    end = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < end:
        if predicate():
            return True
        if MAIN_CTX.pending():
            MAIN_CTX.iteration(False)
        else:
            time.sleep(0.004)
    return predicate()


# ---------------------------------------------------------------- registry

JOURNEYS = []


def journey(query='', known_bug=None, fails_at=None, settings=None, notifications=False, microphone=None):
    """Registers a journey: `def name(page)`. `query` is added to the app's URL
    (for example `journeyCatchUp=held`, a demo that acts like a patched signal-cli).

    `settings` is merged over the stored settings the journey starts with (a mode such as
    `{'appearance': {'shell': 'tui'}}`, or `{'plugins': {'vim-mode': {'enabled': True}}}`): the
    state a user would have chosen before this session. `notifications=True` gives the page a
    granted `Notification` that only records what the app shows (`page.notifications()`), since
    a real desktop notification cannot be observed from here.

    `known_bug` marks a journey that describes behaviour the app does not have
    yet. It must also say where it is expected to fail: `fails_at` is text of
    the journey line (such as `page.expect_stays(is_current(0)`) whose
    expectation does not hold. The journey counts as a known bug only when it
    fails there, by an expectation (never a script error, a missing element, a
    page error or a timeout elsewhere); any other failure fails the run. The run
    also fails when the journey starts passing, so the marker goes with the fix.
    """
    if known_bug is not None and not fails_at:
        raise ValueError('a known_bug journey must say where it fails (fails_at=...)')

    def register(fn):
        JOURNEYS.append(
            {
                'name': fn.__name__,
                'fn': fn,
                'query': query,
                'doc': (fn.__doc__ or '').strip(),
                'known_bug': known_bug,
                'fails_at': fails_at,
                'settings': settings,
                'notifications': notifications,
                'microphone': microphone,
            }
        )
        return fn

    return register


# ---------------------------------------------------------------- page setup

# What the desktop app does (tauri.conf.json `freezePrototype`), and the
# settings that make the demo open straight into the app, quiet and themed.
# `__SETTINGS__` is the stored settings object (JSON), `__NOTIFICATIONS__` and `__MIC_DENIED__` true or false.
PRELOAD_JS = r"""
(function () {
  // A fixed clock: the demo world is built from the current time, so without this the chats hold
  // different messages at different hours and dates. Every run starts at the same local moment
  // (Wednesday 10 June 2026, 15:00) and time then runs normally, across reloads too.
  var Real = Date;
  var offset;
  try { offset = Number(sessionStorage.getItem('__journey_clock')); } catch (e) { offset = 0; }
  if (!offset) {
    offset = new Real(2026, 5, 10, 15, 0, 0).getTime() - Real.now();
    try { sessionStorage.setItem('__journey_clock', String(offset)); } catch (e) { /* per page then */ }
  }
  class JourneyDate extends Real {
    constructor(...args) {
      if (args.length === 0) super(Real.now() + offset);
      else super(...args);
    }
    static now() { return Real.now() + offset; }
  }
  window.Date = JourneyDate;
})();
Object.freeze(Object.prototype);
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', function (e) { window.__errors.push('rejection: ' + String(e.reason)); });
(function () {
  var original = console.error;
  console.error = function () {
    try {
      window.__errors.push('console.error: ' + Array.prototype.map.call(arguments, function (a) {
        return a instanceof Error ? a.message : String(a);
      }).join(' '));
    } catch (e) { /* never break the page's own logging */ }
    return original.apply(console, arguments);
  };
})();
(function () {
  try {
    if (!sessionStorage.getItem('__journey_seeded')) {
      sessionStorage.setItem('__journey_seeded', '1');
      localStorage.setItem('snowdrop.settings', JSON.stringify({ v: 3, data: __SETTINGS__ }));
    }
  } catch (e) { window.__errors.push('seed failed: ' + e); }
})();
if (__MIC_DENIED__) {
  // The user (or the system) said no to the microphone: what a denied permission prompt gives the page.
  var denied = function () { return Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); };
  if (window.MediaDevices) Object.defineProperty(window.MediaDevices.prototype, 'getUserMedia', { value: denied, configurable: true, writable: true });
  else Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: denied }, configurable: true });
}
if (__NOTIFICATIONS__) {
  // Records what the app shows. Granted, so the app takes the same path as with a real permission.
  window.__notified = [];
  window.__notifiedInstances = [];
  window.Notification = function (title, options) {
    var record = { title: String(title), body: String((options && options.body) || ''), tag: String((options && options.tag) || ''), closed: false };
    window.__notified.push(record);
    window.__notifiedInstances.push(this);
    this.close = function () { record.closed = true; };
  };
  window.Notification.permission = 'granted';
  window.Notification.requestPermission = function () { return Promise.resolve('granted'); };
}
"""

BASE_SETTINGS = {
    'appearance': {'themeId': 'dusk'},
    'connection': {'backend': 'mock', 'mockLiveliness': False, 'daemonUrl': '/signal-cli', 'account': None},
}


def _merged(base, extra):
    out = dict(base)
    for key, value in (extra or {}).items():
        out[key] = _merged(out[key], value) if isinstance(out.get(key), dict) and isinstance(value, dict) else value
    return out


def preload_js(settings=None, notifications=False, microphone=None):
    """The script run in every page before the app: frozen prototype, error capture, seeded settings."""
    return (
        PRELOAD_JS.replace('__SETTINGS__', json.dumps(_merged(BASE_SETTINGS, settings)))
        .replace('__NOTIFICATIONS__', 'true' if notifications else 'false')
        .replace('__MIC_DENIED__', 'true' if microphone == 'denied' else 'false')
    )

# DOM-style key names (what the docs and the app say) -> GDK key names.
KEY_NAMES = {
    ' ': 'space',
    'Enter': 'Return',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'PageDown': 'Page_Down',
    'PageUp': 'Page_Up',
    'Shift': 'Shift_L',
    'Control': 'Control_L',
    'Ctrl': 'Control_L',
    'Alt': 'Alt_L',
}

MOD_BITS = {
    'shift': (Gdk.ModifierType.SHIFT_MASK, 'Shift_L'),
    'ctrl': (Gdk.ModifierType.CONTROL_MASK, 'Control_L'),
    'alt': (Gdk.ModifierType.MOD1_MASK, 'Alt_L'),
}
KEY_MOD_BITS = {
    'Shift_L': Gdk.ModifierType.SHIFT_MASK,
    'Control_L': Gdk.ModifierType.CONTROL_MASK,
    'Alt_L': Gdk.ModifierType.MOD1_MASK,
}


def _keyval(name):
    if len(name) == 1:
        kv = Gdk.unicode_to_keyval(ord(name))
    else:
        kv = Gdk.keyval_from_name(KEY_NAMES.get(name, name))
    if kv == 0:
        raise ValueError(f'unknown key: {name!r}')
    return kv


def _step(fn):
    """Marks a Page method as a journey step: a failure inside names it."""

    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        try:
            return fn(self, *args, **kwargs)
        except JourneyFailure:
            raise
        except Exception as e:  # a harness or script error, reported as the step's
            raise JourneyFailure(f'{fn.__name__}: {e}') from e

    return wrapper


class Page:
    """One webview showing the app. Everything a journey does goes through here."""

    def __init__(self, base_url, query='', stored_settings=None, notifications=False, microphone=None):
        self.base_url = base_url
        self.query = query
        self.mods = Gdk.ModifierType(0)  # modifier keys currently held down
        display = Gdk.Display.get_default()
        seat = display.get_default_seat()
        self._keymap = Gdk.Keymap.get_for_display(display)
        self._keyboard = seat.get_keyboard()
        self._pointer = seat.get_pointer()

        data_manager = WebKit2.WebsiteDataManager.new_ephemeral()
        context = WebKit2.WebContext.new_with_website_data_manager(data_manager)
        settings = WebKit2.Settings()
        settings.set_property('hardware-acceleration-policy', WebKit2.HardwareAccelerationPolicy.NEVER)
        content = WebKit2.UserContentManager()
        content.add_script(
            WebKit2.UserScript.new(
                preload_js(stored_settings, notifications, microphone),
                WebKit2.UserContentInjectedFrames.ALL_FRAMES,
                WebKit2.UserScriptInjectionTime.START,
                None,
                None,
            )
        )
        self.webview = WebKit2.WebView(web_context=context, user_content_manager=content, settings=settings)
        # Nothing in the runner has a microphone, camera or location to give: a permission prompt that reaches
        # here is answered "no". (In practice a microphone request in the offscreen window is never answered at all;
        # `microphone='denied'` gives the refusal instead.)
        self.webview.connect('permission-request', lambda _wv, request: request.deny() or True)
        self.webview.set_size_request(WIDTH, HEIGHT)
        self.window = Gtk.OffscreenWindow()
        self.window.set_default_size(WIDTH, HEIGHT)
        self.window.add(self.webview)
        self.window.show_all()
        pump(200)

    # ------------------------------------------------------------ window

    @_step
    def resize(self, width, height):
        """Resizes the window (and so the page), as a user dragging its edge would."""
        self.webview.set_size_request(width, height)
        self.window.set_default_size(width, height)
        self.window.resize(width, height)
        pump(150)
        if not pump_until(lambda: self._run('return window.innerWidth;', 5000) == width, 3000):
            raise JourneyFailure(f'the window did not resize to {width} x {height}')
        pump(150)

    # ------------------------------------------------------------ lifecycle

    def open(self):
        done = {}

        def on_load(_wv, event):
            if event == WebKit2.LoadEvent.FINISHED:
                done['ok'] = True

        self.webview.connect('load-changed', on_load)
        url = self.base_url + (('?' + self.query) if self.query else '')
        self.webview.load_uri(url)
        if not pump_until(lambda: 'ok' in done, 20000):
            raise JourneyFailure('the app did not finish loading')
        # An offscreen window never becomes the active window, so the page
        # would never count as focused and WebKit drops keyboard input.
        self.webview.grab_focus()
        pump(50)
        self.window_focus(True)
        self.wait_for('!!window.__journey && !!document.querySelector("[data-snowdrop=conversation-row]")', 20000)

    @_step
    def window_focus(self, focused):
        """Gives the window focus, or takes it away (the user switching to another app and back). It is
        the focus-change event GTK sends a real window, so the page sees what it sees there: `focus` and
        `blur` on `window`, and `document.hasFocus()` following."""
        ev = Gdk.Event.new(Gdk.EventType.FOCUS_CHANGE)
        ev.window = self.webview.get_window()
        ev.send_event = True
        ev.in_ = bool(focused)
        self.webview.emit('focus-in-event' if focused else 'focus-out-event', ev)
        pump(80)

    def close(self):
        self.window.destroy()
        pump(50)

    # ------------------------------------------------------------ JavaScript

    def _run(self, body, timeout_ms):
        wrapped = (
            'try { const __r = await (async () => { ' + body + ' })();'
            ' return JSON.stringify(__r === undefined ? null : __r); }'
            ' catch (e) { return JSON.stringify({ __err: String((e && e.stack) || e) }); }'
        )
        out = {}

        def cb(wv, task, _data):
            try:
                out['text'] = wv.call_async_javascript_function_finish(task).to_string()
            except GLib.Error as e:
                out['gerror'] = str(e)
            out['done'] = True

        self.webview.call_async_javascript_function(wrapped, -1, None, None, None, None, cb, None)
        pump_until(lambda: 'done' in out, timeout_ms)
        if 'gerror' in out:
            raise JourneyFailure(f'script error: {out["gerror"]}')
        if 'text' not in out:
            raise JourneyFailure('script timed out')
        value = json.loads(out['text'])
        if isinstance(value, dict) and '__err' in value:
            raise ScriptThrew(f'script threw: {value["__err"]}')
        return value

    @staticmethod
    def _as_body(js):
        if re.match(r'\s*(return|const|let|var|if|for)\b', js):
            return js
        return f'return ({js});'

    @_step
    def eval(self, js, timeout=10000):
        """Runs an expression, or a function body (one that starts with `return`,
        `const`, `let`, `var`, `if` or `for`), in the page and returns its JSON
        value. `await` works."""
        return self._run(self._as_body(js), timeout)

    @_step
    def wait_for(self, js, timeout=10000):
        """Waits until the expression is truthy; fails after `timeout` ms. An
        expression that throws (an element not there yet) is retried until then."""
        body = self._as_body(js)
        end = time.monotonic() + timeout / 1000.0
        threw = None
        while True:
            try:
                last = self._run(body, 10000)
                threw = None
                if last:
                    return last
            except ScriptThrew as e:
                threw = e
            if time.monotonic() > end:
                if threw is not None:
                    raise JourneyFailure(f'timed out after {timeout} ms, and the last try threw: {threw}: {one_line(js)}')
                raise ExpectationFailed(f'timed out after {timeout} ms waiting for: {one_line(js)}')
            pump(int(POLL_S * 1000))

    @_step
    def expect_stays(self, js, duration=1000):
        """The expression must be truthy on every poll (about every 50 ms) for
        `duration` ms. This is the regression check for "never changes"."""
        body = self._as_body(js)
        start = time.monotonic()
        polls = 0
        while time.monotonic() - start < duration / 1000.0:
            try:
                value = self._run(body, 10000)
            except ScriptThrew as e:
                raise JourneyFailure(f'threw on poll {polls + 1}, after {int((time.monotonic() - start) * 1000)} ms: {e}: {one_line(js)}') from e
            polls += 1
            if not value:
                raise ExpectationFailed(
                    f'stopped holding after {int((time.monotonic() - start) * 1000)} ms '
                    f'(poll {polls}, got {value!r}): {one_line(js)}'
                )
            pump(int(POLL_S * 1000))

    @_step
    def expect(self, js, message=None):
        """The expression is truthy right now."""
        value = self._run(self._as_body(js), 10000)
        if not value:
            raise ExpectationFailed(message or f'expected: {one_line(js)} (got {value!r})')

    # ------------------------------------------------------------ geometry

    def rect(self, selector):
        r = self._run(
            f'const e = document.querySelector({json.dumps(selector)});'
            ' if (!e) return null; const r = e.getBoundingClientRect();'
            ' return { x: r.x, y: r.y, w: r.width, h: r.height };',
            10000,
        )
        if r is None:
            raise JourneyFailure(f'no element matches {selector!r}')
        if r['w'] <= 0 or r['h'] <= 0:
            raise JourneyFailure(f'{selector!r} has no size')
        return r

    def _centre(self, selector):
        r = self.rect(selector)
        return r['x'] + r['w'] / 2.0, r['y'] + r['h'] / 2.0

    # ------------------------------------------------------------ keyboard

    def _key_event(self, keyval, etype, state, keycode=None, group=None):
        ok, keys = self._keymap.get_entries_for_keyval(keyval)
        entry = keys[0] if ok and keys else None
        ev = Gdk.Event.new(etype)
        ev.window = self.webview.get_window()
        ev.send_event = True
        ev.time = int(time.time() * 1000) & 0xFFFFFFFF
        ev.state = state
        ev.keyval = keyval
        ev.hardware_keycode = keycode if keycode is not None else (entry.keycode if entry else 0)
        ev.group = group if group is not None else (entry.group if entry else 0)
        ev.is_modifier = 1 if Gdk.keyval_name(keyval) in KEY_MOD_BITS else 0
        ev.set_device(self._keyboard)
        return self.webview.event(ev)

    def _tap(self, keyval):
        """Press and release one key. A shifted character (an upper-case letter, `(`)
        is typed the way a keyboard does: Shift goes down first, so the events carry it."""
        ok, keys = self._keymap.get_entries_for_keyval(keyval)
        levels = [k for k in keys] if ok else []
        needs_shift = bool(levels) and all(k.level == 1 for k in levels) and not (self.mods & Gdk.ModifierType.SHIFT_MASK)
        if needs_shift:
            self.key_down('Shift')
        self._key_event(keyval, Gdk.EventType.KEY_PRESS, self.mods)
        self._key_event(keyval, Gdk.EventType.KEY_RELEASE, self.mods)
        if needs_shift:
            self.key_up('Shift')

    @_step
    def key_down(self, name):
        """Presses a key and leaves it down (hold Shift across several steps)."""
        kv = _keyval(name)
        self._key_event(kv, Gdk.EventType.KEY_PRESS, self.mods)
        gdk_name = Gdk.keyval_name(kv)
        if gdk_name in KEY_MOD_BITS:
            self.mods |= KEY_MOD_BITS[gdk_name]
        pump(40)

    @_step
    def key_up(self, name):
        """Releases a key. A modifier's own release still carries its bit, as on a keyboard."""
        kv = _keyval(name)
        self._key_event(kv, Gdk.EventType.KEY_RELEASE, self.mods)
        gdk_name = Gdk.keyval_name(kv)
        if gdk_name in KEY_MOD_BITS:
            self.mods &= ~KEY_MOD_BITS[gdk_name]
        pump(40)

    @_step
    def key(self, name, mods=()):
        """Press and release a key with real key events; `mods` such as ['ctrl']
        are pressed first and released after, like fingers on a keyboard."""
        chord = []
        for m in mods:
            if m not in MOD_BITS:
                raise ValueError(f'unknown modifier {m!r}')
            chord.append(MOD_BITS[m])
        for _bit, mod_key in chord:
            self.key_down(mod_key)
        self._tap(_keyval(name))
        for _bit, mod_key in reversed(chord):
            self.key_up(mod_key)
        pump(60)

    @_step
    def type(self, text):
        """Types text one key at a time."""
        for ch in text:
            self._tap(_keyval('Return' if ch == '\n' else ch))
            pump(8)
        pump(60)

    # ------------------------------------------------------------ pointer

    def _pointer_event(self, etype, x, y, **fields):
        ev = Gdk.Event.new(etype)
        ev.window = self.webview.get_window()
        ev.send_event = True
        ev.time = int(time.time() * 1000) & 0xFFFFFFFF
        ev.x = x
        ev.y = y
        ev.x_root = x
        ev.y_root = y
        ev.state = fields.pop('state', self.mods)
        ev.set_device(self._pointer)
        for k, v in fields.items():
            setattr(ev, k, v)
        return self.webview.event(ev)

    def _move_to(self, x, y):
        # Approach in two steps so the page sees the pointer enter, as a hand would.
        self._pointer_event(Gdk.EventType.MOTION_NOTIFY, x - 6, y - 4)
        pump(20)
        self._pointer_event(Gdk.EventType.MOTION_NOTIFY, x, y)
        pump(60)

    @_step
    def hover(self, selector):
        """Moves the pointer to the element's centre."""
        self._move_to(*self._centre(selector))

    @_step
    def click(self, selector):
        """Moves to the element's centre and clicks the left button."""
        x, y = self._centre(selector)
        self._move_to(x, y)
        self._pointer_event(Gdk.EventType.BUTTON_PRESS, x, y, button=1)
        pump(30)
        self._pointer_event(
            Gdk.EventType.BUTTON_RELEASE, x, y, button=1, state=self.mods | Gdk.ModifierType.BUTTON1_MASK
        )
        pump(80)

    @_step
    def scroll(self, selector, dy):
        """Scrolls the element with real wheel events until its scrollTop has
        moved by `dy` px (positive = down), or it can't move further."""
        x, y = self._centre(selector)
        self._move_to(x, y)
        sel = json.dumps(selector)
        start = self._run(f'return document.querySelector({sel}).scrollTop;', 10000)
        target = start + dy
        stalled = 0
        for _ in range(400):
            now = self._run(f'return document.querySelector({sel}).scrollTop;', 10000)
            remaining = target - now
            if abs(remaining) < 2:
                return self._settle(sel)
            self._pointer_event(
                Gdk.EventType.SCROLL,
                x,
                y,
                direction=Gdk.ScrollDirection.SMOOTH,
                delta_x=0.0,
                delta_y=1.0 if remaining > 0 else -1.0,
            )
            pump(30)
            after = self._run(f'return document.querySelector({sel}).scrollTop;', 10000)
            stalled = stalled + 1 if after == now else 0
            if stalled >= 4:
                return self._settle(sel)  # at the end of the scroller
        raise JourneyFailure('scrolling did not settle')

    def _settle(self, sel):
        """Waits for smooth-scroll animation to finish: scrollTop unchanged for 200 ms."""
        last, since = None, time.monotonic()
        while time.monotonic() - since < 0.2:
            now = self._run(f'return document.querySelector({sel}).scrollTop;', 10000)
            if now != last:
                last, since = now, time.monotonic()
            pump(30)

    # ------------------------------------------------------------ screenshots

    def shot(self, path):
        out = {}

        def cb(wv, task, _data):
            try:
                out['surface'] = wv.get_snapshot_finish(task)
            except GLib.Error as e:
                out['err'] = str(e)
            out['done'] = True

        self.webview.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, cb, None)
        pump_until(lambda: 'done' in out, 10000)
        if 'surface' not in out:
            return False
        out['surface'].write_to_png(str(path))
        return True

    def notifications(self):
        """What the app showed through the page's recording `Notification` (`notifications=True`): a list of
        {title, body, tag, closed}. Check counts and tags; a failure message never needs the text."""
        return self._run('return window.__notified;', 5000)

    @_step
    def click_notification(self, index):
        """The user clicking a shown notification: runs the `onclick` the app gave it (the same handler
        the desktop adapter's click would reach)."""
        self._run(f'const n = window.__notifiedInstances.at({int(index)}); if (!n || !n.onclick) throw new Error("no such notification"); n.onclick(); return 1;', 5000)

    def pixel(self, x, y):
        """The colour (r, g, b) of the window's pixel at page position (x, y), from a real snapshot of what is painted."""
        out = {}

        def cb(wv, task, _data):
            try:
                out['surface'] = wv.get_snapshot_finish(task)
            except GLib.Error as e:
                out['err'] = str(e)
            out['done'] = True

        self.webview.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, cb, None)
        pump_until(lambda: 'done' in out, 10000)
        if 'surface' not in out:
            raise JourneyFailure(f'no snapshot: {out.get("err")}')
        surface = out['surface']
        scale = surface.get_width() / WIDTH
        data, stride = surface.get_data(), surface.get_stride()
        i = int(y * scale) * stride + int(x * scale) * 4
        b, g, r = data[i], data[i + 1], data[i + 2]  # little-endian ARGB32
        return r, g, b

    def page_errors(self):
        """What the page reported: uncaught errors, unhandled rejections and `console.error`
        calls (the app and React log failures that way), minus the noise named below.
        Fails when the page can't answer, so a hung or crashed page never reads as clean."""
        try:
            errors = self._run('return window.__errors || [];', 5000)
        except JourneyFailure as e:
            raise JourneyFailure(f'the page did not respond at the end of the journey: {e}') from e
        return [e for e in errors if not any(e.startswith(p) for p in IGNORED_PAGE_ERRORS)]
