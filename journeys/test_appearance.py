"""Themes and the TUI layout (DECISIONS T4, T5): what is really painted and where it sits, in real WebKitGTK."""
import re

from common import (
    JUMP_PILL,
    DISTANCE,
    SCROLLER,
    SLACK,
    TUI_SETTINGS,
    click_text,
    colour_of,
    fill,
    open_conversation,
    settle,
)
from harness import journey

THEME_TAGS = ('snowdrop-theme', 'snowdrop-plugins', 'snowdrop-custom-css')
BG_CHAT = colour_of('var(--snowdrop-bg-chat)')


def rgb(text):
    return tuple(int(part) for part in re.findall(r'\d+', text)[:3])


def choose_theme(page, theme_id):
    """Settings > Appearance, the theme's card, then back to the chats (all with real input)."""
    page.key(',', ['ctrl'])
    page.wait_for('!!document.querySelector("[role=dialog]")')
    click_text(page, '[role=dialog] button', 'Appearance')
    page.wait_for(f'!!document.querySelector("[data-theme-card={theme_id}]")')
    settle(page, 200)
    # Whether the three tags are still the last children of <head> as the card is clicked. A lazily loaded
    # stylesheet (a dialog's, the composer's popover) lands after them; the app then moves them back on its next
    # apply, as designed. Only a switch with nothing displaced must leave them alone.
    page.eval('(window.__inPlace = %s.every((id, i, ids) => document.head.children[document.head.children.length - ids.length + i]?.id === id), window.__moves = 0, true)' % (list(THEME_TAGS),))
    page.click(f'[data-theme-card="{theme_id}"]')
    page.wait_for(f'document.documentElement.getAttribute("data-theme") === {theme_id!r}')
    page.key('Escape')
    page.wait_for('!document.querySelector("[role=dialog]")')


def chat_paint(page):
    """The pixel painted in an empty strip at the right end of the message list, and the colour the theme says it should be."""
    page.hover('[data-snowdrop=rail]')  # a hovered row is tinted: keep the pointer off the chat
    settle(page, 150)
    box = page.rect('[data-snowdrop=message-pane]')
    return page.pixel(box['x'] + box['w'] - 4, box['y'] + box['h'] / 2), rgb(page.eval(BG_CHAT))


@journey()
def theme_switch_keeps_style_tags_and_repaints(page):
    """Switching theme from Settings never removes or re-adds the three style tags while nothing has displaced them (a WebKitGTK repaint bug), and the chat's computed colour and its painted pixel both change to the new theme's on every switch."""
    open_conversation(page, 'dm-priya')
    before = page.eval(BG_CHAT)
    painted, wanted = chat_paint(page)
    assert painted == wanted, f'dusk is not painted as it says: {painted} vs {wanted}'

    page.eval(
        '(window.__moves = 0, window.__tags = %s.map((id) => document.getElementById(id)),'
        ' new MutationObserver((records) => { for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) if (n.nodeName === "STYLE" && %s.includes(n.id)) window.__moves++; })'
        '   .observe(document.head, { childList: true }), true)' % (list(THEME_TAGS), list(THEME_TAGS))
    )
    choose_theme(page, 'linen')
    settle(page, 300)
    painted, wanted = chat_paint(page)
    assert painted == wanted, f'linen: painted {painted}, the theme says {wanted}'
    assert page.eval(BG_CHAT) != before, 'the computed colour did not change'
    assert painted != rgb(before), 'the chat is still painted with the old theme'

    undisplaced = 0
    for theme_id in ('midnight', 'linen', 'dusk', 'midnight', 'dusk'):
        choose_theme(page, theme_id)
        settle(page, 300)
        if page.eval('window.__inPlace'):
            undisplaced += 1
            page.expect('window.__moves === 0', 'a style tag was detached or added again by a switch with nothing displaced')
        page.expect(
            f'window.__tags.every((t, i) => t === document.getElementById({list(THEME_TAGS)!r}[i]) && t.isConnected)',
            'a style tag is no longer the one that was there',
        )
        painted, wanted = chat_paint(page)
        assert painted == wanted, f'{theme_id}: painted {painted}, the theme says {wanted}'
    page.expect(f'{BG_CHAT} === {before!r}')
    assert undisplaced >= 2, f'only {undisplaced} switches found the tags in place: the no-move check hardly ran'


# ------------------------------------------------------------------ T5

PANES = ('rail', 'sidebar', 'user-panel', 'composer')
RECT = 'const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; };'


@journey(settings=TUI_SETTINGS)
def tui_regions_are_boxed_and_titled(page):
    """The TUI shell: the rail, sidebar, user panel and composer each have a 1px solid border, a title drawn in the top edge (above it, not clipped inside), monospace type and small corners; the chat's title tag sits on its header's top edge; the status line fills the bottom."""
    open_conversation(page, 'dm-priya')
    page.expect('document.documentElement.getAttribute("data-shell") === "tui"')
    mono = page.eval(
        '(() => { const p = document.createElement("span"); p.style.fontFamily = "var(--snowdrop-font-mono)"; document.body.appendChild(p);'
        ' const f = getComputedStyle(p).fontFamily; p.remove(); return f; })()'
    )
    page.expect(f'getComputedStyle(document.body).fontFamily === {mono!r}', 'the TUI shell is not monospace')
    for pane in PANES:
        sel = f'[data-snowdrop={pane}]'
        page.expect(
            f"""(() => {{
              const e = document.querySelector({sel!r}), s = getComputedStyle(e), t = getComputedStyle(e, '::before');
              const title = e.getAttribute('data-pane-title');
              return !!title && s.borderTopWidth === '1px' && s.borderTopStyle === 'solid' && parseFloat(s.borderTopLeftRadius) <= 4
                && t.content.startsWith('"' + title) && t.position === 'absolute' && parseFloat(t.top) < 0 && parseFloat(t.left) > 0;
            }})()""",
            f'{pane} is not a titled box',
        )
    # The chat's title sits across its header's top edge, not inside the header.
    page.expect(
        """(() => {
          const tag = document.querySelector('[data-snowdrop=chat-title-tag]'), head = document.querySelector('[data-snowdrop=chat-header]');
          const a = tag.getBoundingClientRect(), b = head.getBoundingClientRect();
          return tag.textContent.length > 0 && a.top < b.top + 1 && a.bottom > b.top && a.left >= b.left;
        })()""",
        "the chat's title is not on the top edge of its box",
    )
    page.expect(
        """(() => { const s = document.querySelector('[data-snowdrop=status-line]').getBoundingClientRect();
          return Math.abs(s.bottom - innerHeight) < 2 && s.width > innerWidth - 2 && s.height > 10; })()"""
    )


@journey(settings=TUI_SETTINGS)
def tui_messages_sit_in_aligned_columns(page):
    """The TUI shell: every message row has its time, author and text starting at the same x as every other row, and unread counts in the sidebar read [n]."""
    open_conversation(page, 'dm-priya')
    settle(page, 400)
    page.expect(
        """(() => {
          const rows = [...document.querySelectorAll('[data-snowdrop=message]')];
          if (rows.length < 4) return false;
          const left = (sel) => new Set(rows.map((m) => m.querySelector(sel)).filter(Boolean).map((e) => Math.round(e.getBoundingClientRect().left)));
          return left('[data-snowdrop=message-time]').size === 1 && left('[data-snowdrop=message-author]').size === 1 && left('[data-snowdrop=message-body]').size === 1;
        })()""",
        'the message columns do not line up',
    )
    page.expect(
        """(() => {
          const badges = [...document.querySelectorAll('[data-variant=count], [data-variant=mention]')];
          return badges.length > 0 && badges.every((b) => /^\\d+\\+?$/.test(b.textContent.trim())
            && getComputedStyle(b, '::before').content === '"["' && getComputedStyle(b, '::after').content === '"]"');
        })()""",
        'an unread count does not read [n]',
    )


@journey(settings=TUI_SETTINGS)
def tui_jump_chip_sits_in_the_corner(page):
    """The TUI shell: with the list scrolled up and a new message in, the jump-to-latest control is a small chip in the message pane's bottom-right corner, not a bar."""
    open_conversation(page, 'dm-priya')
    fill(page, count=120)
    # (The TUI list has padding below its last row, so its resting distance from the end is not 0.)
    page.eval(f'const s = document.querySelector({SCROLLER!r}); s.scrollTop = s.scrollHeight - s.clientHeight - {page.eval(SLACK)} - 100; return 1;')
    page.wait_for(f'{DISTANCE} > {page.eval(SLACK)} + 50')
    settle(page, 250)
    page.eval("__journey.deliver({ conversation: 'dm-priya', text: 'one more' })")
    page.wait_for(f'!!document.querySelector({JUMP_PILL!r})')
    settle(page, 400)
    page.expect(
        f"""(() => {{
          const chip = document.querySelector({JUMP_PILL!r}).getBoundingClientRect();
          const pane = document.querySelector('[data-snowdrop=message-pane]').getBoundingClientRect();
          return chip.width < 200 && chip.height < 40 && pane.right - chip.right < 40 && pane.bottom - chip.bottom < 40 && chip.left > pane.left + pane.width / 2;
        }})()""",
        'the jump chip is not a small chip in the bottom-right corner',
    )


@journey(settings=TUI_SETTINGS)
def tui_opening_an_unread_chat_reads_it(page):
    """The TUI shell, whose message list is padded: a chat with unread messages, opened at its newest message, is marked read (the newest row is on screen, though the list rests short of its scroll end)."""
    open_conversation(page, 'dm-oren')
    unread = "__journey.state().conversations.find((c) => c.key === 'dm-priya').unread"
    page.eval("__journey.deliver({ conversation: 'dm-priya', count: 3, spacingMs: 50, text: 'while away' })")
    page.wait_for(f'{unread} === 3')
    open_conversation(page, 'dm-priya')
    page.wait_for(f'{unread} === 0', 3000)
