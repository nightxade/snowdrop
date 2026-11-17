import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MENTION_PLACEHOLDER, parseMarkdownToRanges, type BodyRange } from '@/core/domain';
import { isJumbo, MessageBody } from './MessageBody';

afterEach(cleanup);

const names: Record<string, string> = { me: 'Mira Okafor', sam: 'Sam Lee' };
const nameFor = (id: string) => names[id] ?? 'Unknown';

function renderBody(body: string, ranges: BodyRange[] = [], selfId: string | null = 'me') {
  return render(<MessageBody body={body} ranges={ranges} selfId={selfId} nameFor={nameFor} />);
}

describe('MessageBody', () => {
  it('renders native styles as nested elements', () => {
    const { body, ranges } = parseMarkdownToRanges('**bold** *it* ~~gone~~ `x = 1`');
    const { container } = renderBody(body, ranges);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('it');
    expect(container.querySelector('s')?.textContent).toBe('gone');
    expect(container.querySelector('code')?.textContent).toBe('x = 1');
    expect(container.textContent).toBe('bold it gone x = 1');
  });

  it('renders overlapping ranges without losing text', () => {
    const ranges: BodyRange[] = [
      { start: 0, length: 5, style: 'bold' },
      { start: 3, length: 5, style: 'italic' },
    ];
    const { container } = renderBody('abcdefgh', ranges);
    expect(container.textContent).toBe('abcdefgh');
    expect(container.querySelectorAll('strong em, em strong').length).toBeGreaterThan(0);
  });

  it('turns multi-line monospace into a code block', () => {
    const { body, ranges } = parseMarkdownToRanges('```\nconst a = 1;\nconst b = 2;\n```');
    const { container } = renderBody(body, ranges);
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('const a = 1;\nconst b = 2;');
  });

  it('renders mentions as pills, marking mentions of the viewer', () => {
    const body = `hi ${MENTION_PLACEHOLDER} and ${MENTION_PLACEHOLDER}`;
    const ranges: BodyRange[] = [
      { start: 3, length: 1, mentionId: 'me' },
      { start: 9, length: 1, mentionId: 'sam' },
    ];
    renderBody(body, ranges);
    const me = screen.getByRole('button', { name: '@Mira Okafor' });
    const sam = screen.getByRole('button', { name: '@Sam Lee' });
    expect(me.hasAttribute('data-self')).toBe(true);
    expect(sam.hasAttribute('data-self')).toBe(false);
  });

  it('drops stray mention placeholders that have no range', () => {
    const { container } = renderBody(`a${MENTION_PLACEHOLDER}b`);
    expect(container.textContent).toBe('ab');
  });

  it('hides spoilers until activated by click', () => {
    const { body, ranges } = parseMarkdownToRanges('the ending: ||they win||');
    renderBody(body, ranges);
    const spoiler = screen.getByRole('button', { name: /Spoiler/u });
    expect(spoiler.getAttribute('tabindex')).toBe('0');
    fireEvent.click(spoiler);
    expect(screen.queryByRole('button', { name: /Spoiler/u })).toBeNull();
    expect(screen.getByText('they win')).toBeTruthy();
  });

  it('reveals spoilers from the keyboard', () => {
    const { body, ranges } = parseMarkdownToRanges('||secret||');
    renderBody(body, ranges);
    fireEvent.keyDown(screen.getByRole('button', { name: /Spoiler/u }), { key: 'Enter' });
    expect(screen.queryByRole('button', { name: /Spoiler/u })).toBeNull();
  });

  it('keeps a link inside a hidden spoiler out of reach until the spoiler is revealed', () => {
    const { body, ranges } = parseMarkdownToRanges('||https://example.org/secret||');
    const { container } = renderBody(body, ranges);
    // Hidden: neither focusable nor clickable (an inert subtree), so a click on the bar
    // can only reveal it and never follows the link.
    const hidden = container.querySelector('a');
    expect(hidden?.closest('[inert]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Spoiler/u }));
    const link = screen.getByRole('link');
    expect(link.closest('[inert]')).toBeNull();
    expect(link.getAttribute('href')).toBe('https://example.org/secret');
  });

  it('links http(s) URLs safely', () => {
    renderBody('see https://example.org/a?b=1.');
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.org/a?b=1');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('links bare domains and keeps balanced brackets, leaving prose brackets outside', () => {
    renderBody('(see en.wikipedia.org/wiki/Foo and https://en.wikipedia.org/wiki/Foo_(bar)) ok');
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'en.wikipedia.org/wiki/Foo',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    expect(links[0]?.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Foo');
  });

  it('never links a domain split by a custom emoji or by formatting', () => {
    const resolve = (name: string) => (name === 'blob' ? 'data:image/png;base64,AA==' : undefined);
    render(
      <MessageBody
        body="pay:blob:pal.com and example.org:blob: and :blob: ok.net"
        ranges={[]}
        selfId={null}
        nameFor={nameFor}
        resolveCustomEmoji={resolve}
      />,
    );
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['ok.net']);
    cleanup();
    const bold = parseMarkdownToRanges('pay**pal.com** and **bold** x.org');
    renderBody(bold.body, bold.ranges);
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['x.org']);
  });

  it('keeps a whole domain or a full address a link next to an emoji or formatting', () => {
    const body = 'example.com see https://x.org/a';
    renderBody(body, [
      { start: 0, length: 11, style: 'bold' },
      { start: body.length - 1, length: 1, style: 'bold' },
    ]);
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'example.com',
      'https://x.org/',
    ]);
  });

  it('leaves links as plain text when disabled', () => {
    render(
      <MessageBody
        body="example.com https://x.org"
        ranges={[]}
        selfId={null}
        nameFor={nameFor}
        linksEnabled={false}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders previews statically (no nested controls)', () => {
    const body = `${MENTION_PLACEHOLDER} https://x.org ||s||`;
    const { body: b, ranges } = parseMarkdownToRanges(body);
    const withMention = [...ranges, { start: 0, length: 1, mentionId: 'sam' }];
    const { container } = render(
      <MessageBody body={b} ranges={withMention} selfId={null} nameFor={nameFor} preview />,
    );
    expect(container.querySelector('button, a, [role="button"]')).toBeNull();
  });

  it('sets dir="auto" so RTL text renders in its own direction', () => {
    const { container } = renderBody('שלום עולם');
    expect(container.querySelector('[data-snowdrop="message-body"]')?.getAttribute('dir')).toBe(
      'auto',
    );
  });

  it('detects emoji-only messages for jumbo display', () => {
    expect(isJumbo('🎯🎯', [])).toBe(true);
    expect(isJumbo('👍🏽 ❤️', [])).toBe(true);
    expect(isJumbo('ok 👍', [])).toBe(false);
    expect(isJumbo('🎯', [{ start: 0, length: 2, style: 'bold' }])).toBe(false);
  });

  it('never shows digits, # or * large on their own, but does show keycaps and flags', () => {
    expect(isJumbo('2', [])).toBe(false);
    expect(isJumbo('42', [])).toBe(false);
    expect(isJumbo('# *', [])).toBe(false);
    expect(isJumbo('2 👍', [])).toBe(false);
    expect(isJumbo('2️⃣', [])).toBe(true);
    expect(isJumbo('🇫🇷', [])).toBe(true);
    expect(isJumbo('👩‍👩‍👧‍👦 🏳️‍🌈', [])).toBe(true);
  });

  it('shows a plain emoji large without needing a selector, astral or not', () => {
    for (const emoji of ['😀', '🎉', '🫶', '⌚', '✅', '⭐', '👩‍💻', '👍🏽', '🟡']) {
      expect(isJumbo(emoji, [])).toBe(true);
    }
    expect(isJumbo('😀🎉😀🎉😀🎉😀🎉😀🎉', [])).toBe(true);
    expect(isJumbo('😀🎉😀🎉😀🎉😀🎉😀🎉😀', [])).toBe(false);
    expect(isJumbo('😀 a', [])).toBe(false);
    expect(isJumbo('😀2', [])).toBe(false);
  });

  it('does not show text-presentation symbols large unless they carry the emoji selector', () => {
    for (const symbol of ['©', '®', '™', '↔', '▶', '☺', '❤', '‼']) {
      expect(isJumbo(symbol, [])).toBe(false);
      expect(isJumbo(`${symbol}\ufe0f`, [])).toBe(true);
    }
    expect(isJumbo('❤️', [])).toBe(true);
    // Parts that are not pictographs of their own: half a flag, a bare skin-tone swatch.
    expect(isJumbo('🇦', [])).toBe(false);
    expect(isJumbo('🏻', [])).toBe(false);
    expect(isJumbo('🇦 🇧', [])).toBe(false);
    expect(isJumbo('👨‍👩‍👧‍👦 🏳️‍🌈 ❤️‍🔥', [])).toBe(true);
    expect(isJumbo('🫶🏽 🇺🇸', [])).toBe(true);
    expect(isJumbo('❤ ❤️', [])).toBe(false);
    // Real emoji, a skin tone on a text-default pictograph, keycaps and flags still are.
    expect(isJumbo('😀 😀', [])).toBe(true);
    expect(isJumbo('☝🏽', [])).toBe(true);
    expect(isJumbo('1️⃣', [])).toBe(true);
    expect(isJumbo('🇫🇷', [])).toBe(true);
  });

  const wave = (name: string) => (name === 'wave' ? 'data:image/png;base64,aGVsbG8=' : undefined);

  it('renders a resolvable :name: token as its image', () => {
    const { container } = render(
      <MessageBody
        body="hi :wave: there"
        ranges={[]}
        selfId="me"
        nameFor={nameFor}
        resolveCustomEmoji={wave}
      />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(container.textContent).toBe('hi  there');
  });

  it('leaves an unresolved :name: token as plain text', () => {
    const { container } = renderBody(':mystery:', [], null);
    expect(container.textContent).toBe(':mystery:');
    expect(container.querySelector('img')).toBeNull();
  });

  it('never resolves custom emoji without an explicit resolver (received messages)', () => {
    const { container } = render(
      <MessageBody body=":wave:" ranges={[]} selfId="me" nameFor={nameFor} />,
    );
    expect(container.textContent).toBe(':wave:');
    expect(container.querySelector('img')).toBeNull();
  });

  it('counts a resolvable custom emoji as one unit for jumbo display', () => {
    expect(isJumbo(':wave:', [], wave)).toBe(true);
    expect(isJumbo(':wave::wave:', [], wave)).toBe(true);
    // Unresolved: just text, never jumbo.
    expect(isJumbo(':mystery:', [], wave)).toBe(false);
  });
});
