/**
 * Mentions in a plain textarea.
 *
 * The composer shows a mention as readable text ("@Mira Okafor") and keeps
 * a list of the mentions it inserted. On send, every occurrence of a known
 * label becomes Signal's U+FFFC placeholder and its id joins `mentionIds`
 * in document order — exactly what SendService.compose expects. A label the
 * user has edited no longer matches and is sent as the text it now is.
 */
import { MENTION_PLACEHOLDER } from '@/core/domain';

export interface MentionToken {
  id: string;
  /** Includes the "@". */
  label: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Replaces known mention labels with placeholders; returns the ids in order. */
export function encodeMentions(
  text: string,
  tokens: readonly MentionToken[],
): { text: string; mentionIds: string[] } {
  const byLabel = new Map<string, string>();
  for (const t of tokens) if (t.label.length > 1) byLabel.set(t.label, t.id);
  if (byLabel.size === 0) return { text, mentionIds: [] };
  // Longest first so "@Sam Lee" wins over "@Sam"; a label must end at a word boundary.
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`(?:${labels.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  const mentionIds: string[] = [];
  const out = text.replace(pattern, (label) => {
    mentionIds.push(byLabel.get(label) as string);
    return MENTION_PLACEHOLDER;
  });
  return { text: out, mentionIds };
}

/**
 * Tokens for mentions already present in some text (a restored draft): any
 * "@Name" of a known member counts, as if picked from autocomplete.
 */
export function tokensInText(
  text: string,
  people: readonly { id: string; name: string }[],
): MentionToken[] {
  if (!text.includes('@')) return [];
  return people.flatMap((p) => {
    const label = `@${p.name}`;
    return text.includes(label) ? [{ id: p.id, label }] : [];
  });
}

/** Adds a token unless an identical one is known. */
export function addToken(tokens: readonly MentionToken[], token: MentionToken): MentionToken[] {
  return tokens.some((t) => t.id === token.id && t.label === token.label)
    ? [...tokens]
    : [...tokens, token];
}
