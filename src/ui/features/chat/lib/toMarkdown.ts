/**
 * Message body + ranges → the markdown a user would type to produce it.
 * Used for "Copy as Markdown" and to seed the inline editor, so editing a
 * formatted message round-trips through the same markdown → ranges parser.
 */
import {
  escapeMarkdown,
  MENTION_PLACEHOLDER,
  rangesToSegments,
  type BodyRange,
  type Segment,
  type TextStyle,
} from '@/core/domain';

const MARKS: Record<Exclude<TextStyle, 'monospace'>, string> = {
  bold: '**',
  italic: '*',
  strikethrough: '~~',
  spoiler: '||',
};

export interface MarkdownMention {
  id: string;
  /** What the mention reads as in the text, e.g. "@Mira Okafor". */
  label: string;
}

export interface MarkdownResult {
  text: string;
  /** Mentions in document order (the composer turns them back into ranges). */
  mentions: MarkdownMention[];
}

export function toMarkdown(
  body: string,
  ranges: readonly BodyRange[],
  nameFor: (id: string) => string,
): MarkdownResult {
  const mentions: MarkdownMention[] = [];
  const plain = (segments: readonly Segment[]): string =>
    segments
      .map((s) => {
        if (s.type === 'text') return s.text;
        if (s.type === 'mention') return `@${nameFor(s.mentionId)}`;
        return plain(s.children);
      })
      .join('');
  const walk = (segments: readonly Segment[]): string =>
    segments
      .map((s) => {
        if (s.type === 'text') return escapeMarkdown(s.text.replaceAll(MENTION_PLACEHOLDER, ''));
        if (s.type === 'mention') {
          const label = `@${nameFor(s.mentionId)}`;
          mentions.push({ id: s.mentionId, label });
          return label;
        }
        if (s.style === 'monospace') {
          const code = plain(s.children);
          if (code.includes('\n')) return `\`\`\`\n${code}\n\`\`\``;
          return code.includes('`') ? `\`\` ${code} \`\`` : `\`${code}\``;
        }
        const inner = walk(s.children);
        // Markers must hug non-space text or they won't parse back as formatting.
        const lead = /^\s*/u.exec(inner)?.[0] ?? '';
        const trail = /\s*$/u.exec(inner)?.[0] ?? '';
        const core = inner.slice(lead.length, inner.length - trail.length);
        if (core === '') return inner;
        const mark = MARKS[s.style];
        return `${lead}${mark}${core}${mark}${trail}`;
      })
      .join('');
  return { text: walk(rangesToSegments(body, ranges)), mentions };
}
