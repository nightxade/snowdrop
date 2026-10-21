/**
 * Markdown-lite → Signal body ranges.
 *
 * Signal carries formatting as `(start, length, style)` ranges over a plain
 * body, not as markup. Converting the composer's markdown into ranges before
 * sending means recipients on the official apps see *native* formatting and
 * never stray asterisks.
 *
 * Supported syntax (a chat-oriented subset of CommonMark + GFM):
 *   **bold**  *italic*  _italic_  ***both***  ~~strike~~  ||spoiler||
 *   `code`  ``code with ` inside``  ```lang\nfenced code```
 *   \*  (backslash escapes any of  \ * _ ~ | ` )
 *
 * The algorithm is CommonMark's delimiter-run procedure: runs of `*`/`_`
 * are classified as left/right-flanking, then matched closer-by-closer
 * against a delimiter stack with the "rule of 3" and per-kind lower bounds
 * (`openersBottom`), which keeps it linear in the input length.
 *
 * Deliberate differences from CommonMark, tuned for chat:
 * - `__x__` is *not* bold (runs of 2+ underscores are literal), so
 *   `__init__.py` and `snake__case` survive intact.
 * - `~~` and `||` must be exactly two characters and follow the stricter
 *   underscore flanking rules, so `if (a||b)` stays literal.
 * - URLs (http/https) are atomic like code spans: `web.archive.org/web/*`
 *   never opens emphasis.
 * - All indices are UTF-16 code units — Signal's wire unit and JavaScript's
 *   native string index — so no conversion is needed.
 */
import { MAX_BODY_RANGES, type BodyRange, type TextStyle } from './types';

export interface ParsedMarkdown {
  body: string;
  ranges: BodyRange[];
}

type DelimChar = '*' | '_' | '~' | '|';

interface TextToken {
  kind: 'text';
  text: string;
}

interface CodeToken {
  kind: 'code';
  text: string;
}

interface DelimToken {
  kind: 'delim';
  char: DelimChar;
  /** Original run length. */
  length: number;
  /** Characters consumed from the left (as a closer) / right (as an opener). */
  usedLeft: number;
  usedRight: number;
  canOpen: boolean;
  canClose: boolean;
  /** Output offsets, filled during assembly. */
  closeAt: number;
  openAt: number;
}

type Token = TextToken | CodeToken | DelimToken;

/** Doubly linked delimiter-stack entry. */
interface StackNode {
  token: DelimToken;
  /** Characters still available for matching. */
  count: number;
  prev: StackNode | null;
  next: StackNode | null;
}

interface Span {
  opener: DelimToken;
  closer: DelimToken;
  style: TextStyle;
}

const ESCAPABLE = new Set(['\\', '*', '_', '~', '|', '`']);
const DELIM_CHARS = new Set<string>(['*', '_', '~', '|']);

const isWhitespace = (ch: string | undefined): boolean => ch === undefined || /\s/u.test(ch);
const isPunctuation = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Language tags we strip from the first line of a fenced block. Anything else is content. */
const CODE_LANGUAGES = new Set(
  (
    'js javascript ts typescript jsx tsx json json5 py python rb ruby rs rust go java kt kotlin ' +
    'c h cpp c++ cc hpp cs csharp fs fsharp swift dart lua r php pl perl sh bash zsh fish shell ' +
    'console ps powershell sql html xml svg css scss sass less yaml yml toml ini md markdown diff ' +
    'patch text txt plaintext dockerfile makefile graphql gql proto elixir ex erlang hs haskell ' +
    'scala clj clojure ocaml ml nix vim zig asm wasm tex latex csv log'
  ).split(' '),
);

// ─── Code spans ────────────────────────────────────────────────────────────

/** Positions of every maximal backtick run, grouped by run length, ascending. */
function indexBacktickRuns(src: string): Map<number, number[]> {
  const byLength = new Map<number, number[]>();
  for (let i = 0; i < src.length;) {
    if (src[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (src[i + n] === '`') n++;
    const list = byLength.get(n);
    if (list) list.push(i);
    else byLength.set(n, [i]);
    i += n;
  }
  return byLength;
}

/** First element of a sorted list strictly greater than `after` (binary search). */
function firstAfter(list: readonly number[], after: number): number | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as number) > after) hi = mid;
    else lo = mid + 1;
  }
  return list[lo];
}

function fencedContent(raw: string): string {
  let content = raw;
  const tag = /^[ \t]*([A-Za-z][\w+#.-]{0,15})[ \t]*\n/u.exec(content);
  if (tag && CODE_LANGUAGES.has((tag[1] as string).toLowerCase()))
    content = content.slice(tag[0].length);
  else if (content.startsWith('\n')) content = content.slice(1);
  if (content.endsWith('\n')) content = content.slice(0, -1);
  return content;
}

function inlineContent(raw: string): string {
  // CommonMark: strip one surrounding space so `` ` `` `` can show a backtick.
  if (raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() !== '') {
    return raw.slice(1, -1);
  }
  return raw;
}

// ─── Tokenizer ─────────────────────────────────────────────────────────────

const URL_START = /^https?:\/\//iu;
const URL_BODY = /^https?:\/\/[^\s<>"`]+/iu;
const URL_TRAILING = /[.,!?;:'")\]}*_~|]+$/u;

function classify(
  src: string,
  start: number,
  length: number,
  char: DelimChar,
): Pick<DelimToken, 'canOpen' | 'canClose'> {
  const before = src[start - 1];
  const after = src[start + length];
  const leftFlanking =
    !isWhitespace(after) &&
    (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  const rightFlanking =
    !isWhitespace(before) &&
    (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
  if (char === '*') return { canOpen: leftFlanking, canClose: rightFlanking };
  // `_`, `~~` and `||` never open or close inside a word.
  return {
    canOpen: leftFlanking && (!rightFlanking || isPunctuation(before)),
    canClose: rightFlanking && (!leftFlanking || isPunctuation(after)),
  };
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const runs = indexBacktickRuns(src);
  let text = '';
  const flush = (): void => {
    if (text) tokens.push({ kind: 'text', text });
    text = '';
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;

    if (ch === '\\' && ESCAPABLE.has(src.charAt(i + 1))) {
      text += src.charAt(i + 1);
      i += 2;
      continue;
    }

    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n++;
      const close = firstAfter(runs.get(n) ?? [], i + n - 1);
      const raw = close === undefined ? '' : src.slice(i + n, close);
      const content = close === undefined ? '' : n >= 3 ? fencedContent(raw) : inlineContent(raw);
      if (close === undefined || content === '') {
        // Unmatched (or empty) runs are literal text.
        const end = close === undefined ? i + n : close + n;
        text += src.slice(i, end);
        i = end;
        continue;
      }
      flush();
      tokens.push({ kind: 'code', text: content });
      i = close + n;
      continue;
    }

    if (
      (ch === 'h' || ch === 'H') &&
      !isWordChar(src[i - 1]) &&
      URL_START.test(src.slice(i, i + 8))
    ) {
      const match = URL_BODY.exec(src.slice(i, i + 2048));
      if (match) {
        const url = match[0].replace(URL_TRAILING, '');
        text += url;
        i += url.length;
        continue;
      }
    }

    if (DELIM_CHARS.has(ch)) {
      const char = ch as DelimChar;
      let n = 0;
      while (src[i + n] === ch) n++;
      // `~~`/`||` must be exactly two; `_` runs longer than one are literal (no __bold__).
      const valid = char === '*' || (char === '_' ? n === 1 : n === 2);
      if (!valid) {
        text += src.slice(i, i + n);
        i += n;
        continue;
      }
      flush();
      tokens.push({
        kind: 'delim',
        char,
        length: n,
        usedLeft: 0,
        usedRight: 0,
        closeAt: 0,
        openAt: 0,
        ...classify(src, i, n, char),
      });
      i += n;
      continue;
    }

    text += ch;
    i++;
  }
  flush();
  return tokens;
}

// ─── Emphasis matching (CommonMark "process emphasis") ─────────────────────

function styleFor(char: DelimChar, use: number): TextStyle {
  if (char === '~') return 'strikethrough';
  if (char === '|') return 'spoiler';
  return use === 2 ? 'bold' : 'italic';
}

function matchEmphasis(tokens: readonly Token[]): Span[] {
  let head: StackNode | null = null;
  let tail: StackNode | null = null;
  for (const token of tokens) {
    if (token.kind !== 'delim' || (!token.canOpen && !token.canClose)) continue;
    const node: StackNode = { token, count: token.length, prev: tail, next: null };
    if (tail) tail.next = node;
    else head = node;
    tail = node;
  }

  const remove = (node: StackNode): void => {
    if (node.prev) node.prev.next = node.next;
    else head = node.next;
    if (node.next) node.next.prev = node.prev;
    else tail = node.prev;
  };

  const spans: Span[] = [];
  // Lower bound for the opener search, per closer kind; this is what keeps it linear.
  const openersBottom = new Map<string, StackNode | null>();
  let current: StackNode | null = head;

  while (current) {
    const closer: StackNode = current;
    const c = closer.token;
    if (!c.canClose) {
      current = closer.next;
      continue;
    }
    const key = `${c.char}${c.canOpen ? 1 : 0}${c.length % 3}`;
    const bottom = openersBottom.has(key) ? openersBottom.get(key) : undefined;

    let opener = closer.prev;
    while (opener && opener !== bottom) {
      const o = opener.token;
      if (o.char === c.char && o.canOpen) {
        const needsPair = c.char === '~' || c.char === '|';
        // Rule of 3 (CommonMark): prevents `*foo**bar*` style mis-nesting.
        const ruleOf3 =
          !needsPair &&
          (o.canClose || c.canOpen) &&
          (o.length + c.length) % 3 === 0 &&
          !(o.length % 3 === 0 && c.length % 3 === 0);
        if (!ruleOf3 && (!needsPair || (opener.count >= 2 && closer.count >= 2))) break;
      }
      opener = opener.prev;
    }

    if (opener && opener !== bottom) {
      const pair = c.char === '~' || c.char === '|';
      const use = pair ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      spans.push({ opener: opener.token, closer: c, style: styleFor(c.char, use) });
      opener.count -= use;
      closer.count -= use;
      opener.token.usedRight += use;
      c.usedLeft += use;
      // Delimiters between a matched pair can no longer match anything.
      for (let n = opener.next; n && n !== closer; n = n.next) remove(n);
      if (opener.count === 0) remove(opener);
      if (closer.count === 0) {
        current = closer.next;
        remove(closer);
      }
    } else {
      openersBottom.set(key, closer.prev);
      current = closer.next;
      if (!c.canOpen) remove(closer);
    }
  }
  return spans;
}

// ─── Assembly ──────────────────────────────────────────────────────────────

export function parseMarkdownToRanges(text: string): ParsedMarkdown {
  const tokens = tokenize(text);
  const spans = matchEmphasis(tokens);

  let body = '';
  const ranges: BodyRange[] = [];
  for (const token of tokens) {
    if (token.kind === 'text') {
      body += token.text;
    } else if (token.kind === 'code') {
      ranges.push({ start: body.length, length: token.text.length, style: 'monospace' });
      body += token.text;
    } else {
      // Closer chars are consumed from the left, opener chars from the right;
      // whatever is left in the middle is literal.
      token.closeAt = body.length;
      body += token.char.repeat(token.length - token.usedLeft - token.usedRight);
      token.openAt = body.length;
    }
  }
  for (const span of spans) {
    const length = span.closer.closeAt - span.opener.openAt;
    if (length > 0) ranges.push({ start: span.opener.openAt, length, style: span.style });
  }
  return { body, ranges: normalizeRanges(ranges) };
}

/**
 * Merges overlapping or touching ranges of the same style. Nested emphasis of
 * one style (`**a *b**` → italic inside italic) is legal CommonMark but means
 * nothing to Signal, and overlapping duplicates confuse recipients' clients.
 * Output: sorted by start, then longer first; no two same-style ranges overlap.
 */
function normalizeRanges(ranges: readonly BodyRange[]): BodyRange[] {
  const byStyle = new Map<TextStyle | undefined, BodyRange[]>();
  for (const r of ranges) {
    const list = byStyle.get(r.style);
    if (list) list.push(r);
    else byStyle.set(r.style, [r]);
  }
  const out: BodyRange[] = [];
  for (const list of byStyle.values()) {
    list.sort((a, b) => a.start - b.start);
    let current: BodyRange | undefined;
    for (const r of list) {
      if (current && r.start <= current.start + current.length) {
        const end = Math.max(current.start + current.length, r.start + r.length);
        current = { ...current, length: end - current.start };
      } else {
        if (current) out.push(current);
        current = { ...r };
      }
    }
    if (current) out.push(current);
  }
  // Bounded like every other source of ranges (see MAX_BODY_RANGES).
  return out.sort((a, b) => a.start - b.start || b.length - a.length).slice(0, MAX_BODY_RANGES);
}

/** Escapes text so it round-trips through parseMarkdownToRanges unchanged. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~|`]/gu, (m) => `\\${m}`);
}
