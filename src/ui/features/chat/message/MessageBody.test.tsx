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

  it('links http(s) URLs safely', () => {
    renderBody('see https://example.org/a?b=1.');
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.org/a?b=1');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
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
