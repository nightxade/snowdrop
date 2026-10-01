import { definePlugin } from '../types';
import { defineSettings } from '../settings';

/**
 * Tracking parameters that identify *you* (or the share event) rather than
 * the content. Trailing `*` is a prefix wildcard.
 */
export const DEFAULT_TRACKING_PARAMS: readonly string[] = [
  'utm_*',
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'ref_src',
  'ref_url',
  'si',
  'spm',
  'vero_id',
  'oly_enc_id',
  'oly_anon_id',
  'wickedid',
  'rb_clickid',
];

// Stop at whitespace and characters that can't end a URL in chat text.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:)\]}'"]+$/u;

export function parseParamList(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

function matcher(patterns: readonly string[]): (name: string) => boolean {
  const exact = new Set(patterns.filter((p) => !p.endsWith('*')));
  const prefixes = patterns.filter((p) => p.endsWith('*')).map((p) => p.slice(0, -1));
  return (name) => {
    const lower = name.toLowerCase();
    return exact.has(lower) || prefixes.some((p) => lower.startsWith(p));
  };
}

/** Removes tracking parameters from one URL; returns it unchanged if it can't be parsed. */
export function cleanUrl(url: string, extra: readonly string[] = []): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const isTracking = matcher([...DEFAULT_TRACKING_PARAMS, ...extra]);
  const keys = [...new Set([...parsed.searchParams.keys()])];
  const toRemove = keys.filter(isTracking);
  if (toRemove.length === 0) return url;
  for (const key of toRemove) parsed.searchParams.delete(key);
  let out = parsed.toString();
  // URL serialisation leaves a dangling "?" when every param was removed.
  if (parsed.search === '' && out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

/** Cleans every URL in a message body, preserving surrounding punctuation. */
export function stripTrackingParams(text: string, extra: readonly string[] = []): string {
  return text.replace(URL_PATTERN, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    // Keep a closing paren that belongs to the URL (e.g. Wikipedia's "Foo_(bar)")
    // only when the URL itself has an unmatched "(".
    const core = match.slice(0, match.length - trailing.length);
    const count = (ch: string) => core.split(ch).length - 1;
    const balanced = trailing.startsWith(')') && count('(') > count(')') ? `${core})` : core;
    const rest = match.slice(balanced.length);
    return cleanUrl(balanced, extra) + rest;
  });
}

export const clearUrlsPlugin = definePlugin({
  id: 'clear-urls',
  name: 'Clear URLs',
  description: 'Strips tracking parameters (utm_*, fbclid, …) from links you send.',
  authors: ['shrike'],
  tags: ['privacy', 'messages'],
  enabledByDefault: true,
  settings: defineSettings({
    extraParams: {
      type: 'string',
      label: 'Extra parameters',
      description: 'Comma-separated names to strip as well. End with * to match a prefix.',
      default: '',
      placeholder: 'ref, source_*',
    },
  }),
  start(ctx) {
    ctx.send.addTransform((draft) => ({
      ...draft,
      text: stripTrackingParams(draft.text, parseParamList(ctx.settings.get('extraParams'))),
    }));
  },
});
