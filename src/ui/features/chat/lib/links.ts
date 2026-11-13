/**
 * Finding web addresses in message text.
 *
 * Explicit `http(s)://` addresses are found by `explicitUrls`, which keeps a
 * closing bracket that matches an opening one inside the address
 * (`.../Foo_(bar)`) and drops one that closes surrounding prose
 * (`(see https://x.org)`). `findLinks` also picks up bare domains
 * (`example.com`, `www.example.com/path`) through linkify-it, as Signal
 * Desktop does. Link previews use `explicitUrls` only, so a bare domain
 * never triggers a fetch.
 */
import LinkifyIt from 'linkify-it';

export interface FoundLink {
  /** The text as typed. */
  text: string;
  /** Always http(s); a bare domain gets `https://`. */
  href: string;
  start: number;
  end: number;
}

/**
 * Bidi controls (zero-width and direction marks, embeddings, overrides,
 * isolates): they can reorder how an address is drawn, so an address never
 * contains one.
 */
const BIDI_CONTROLS = '\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069';
const EXPLICIT_URL = new RegExp(`\\bhttps?://[^\\s<>"'${BIDI_CONTROLS}]+`, 'giu');
const HAS_BIDI_CONTROL = new RegExp(`[${BIDI_CONTROLS}]`, 'u');
const TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  // Closing quotes and brackets and CJK punctuation that end a sentence around an address.
  '\u201D',
  '\u2019',
  '\u00BB',
  '\u300D',
  '\uFF09',
  '\u3002',
  '\u3001',
  '\u2026',
]);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

/** Drops trailing punctuation and any closing bracket with no opener inside the address. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    const opener = CLOSERS[last];
    if (TRAILING_PUNCTUATION.has(last) || (opener && count(url, last) > count(url, opener))) {
      url = url.slice(0, -1);
    } else return url;
  }
}

/** Explicit `http(s)://` addresses only, in order. */
export function explicitUrls(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of text.matchAll(EXPLICIT_URL)) {
    const url = trimUrl(match[0]);
    // A bare scheme with nothing after it is not an address.
    if (/^https?:\/\/$/iu.test(url)) continue;
    found.push({ text: url, href: url, start: match.index, end: match.index + url.length });
  }
  return found;
}

const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: false, fuzzyIP: false });

/** Explicit addresses plus bare domains; mailto:, ftp: and the like stay plain text. */
export function findLinks(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  let last = 0;
  const bareIn = (from: number, to: number) => {
    if (to <= from) return;
    for (const m of linkify.match(text.slice(from, to)) ?? []) {
      if (m.schema !== '' || HAS_BIDI_CONTROL.test(m.text)) continue;
      found.push({
        text: m.text,
        href: `https://${m.text}`,
        start: from + m.index,
        end: from + m.lastIndex,
      });
    }
  };
  for (const url of explicitUrls(text)) {
    bareIn(last, url.start);
    found.push(url);
    last = url.end;
  }
  bareIn(last, text.length);
  return found;
}
