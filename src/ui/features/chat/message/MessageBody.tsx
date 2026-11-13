import {
  cloneElement,
  Fragment,
  memo,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { MENTION_PLACEHOLDER, rangesToSegments, type BodyRange, type Segment } from '@/core/domain';
import { CUSTOM_EMOJI_TOKEN } from '@/core/stores/customEmoji';
import { splitGraphemes } from '@/ui/lib/graphemes';
import { findLinks } from '../lib/links';
import styles from './MessageBody.module.css';

export interface MessageBodyProps {
  body: string;
  ranges: readonly BodyRange[];
  selfId: string | null;
  nameFor: (id: string) => string;
  /** Wraps a mention pill (a button) — e.g. as a profile popout trigger. */
  renderMention?: (id: string, pill: ReactElement) => ReactNode;
  className?: string | undefined;
  /** For aria-describedby on the row. */
  id?: string;
  /**
   * Static rendering for previews inside other controls (search results):
   * no links, buttons or reveal toggles, which can't nest in a button.
   */
  preview?: boolean;
  /** Inline content after the text, e.g. the "(edited)" tag. */
  trailing?: ReactNode;
  /**
   * Resolves a `:name:` token to a custom emoji image, if one should render
   * inline here. Own messages resolve from the viewer's own collection;
   * received messages resolve from that specific message's own delivered
   * emoji, when the sender's signal-cli could deliver them (see
   * docs/SIGNAL_CLI.md) — never the viewer's own collection, which has
   * nothing to do with what the sender used. Omitting this prop, or the
   * resolver returning undefined (not found, or still loading), renders
   * `:name:` as plain text.
   */
  resolveCustomEmoji?: (name: string) => string | undefined;
  /**
   * Wraps a resolved custom emoji's image — e.g. as the trigger of the
   * "Add to my emoji" popover for an emoji someone else delivered.
   */
  renderCustomEmoji?: (name: string, image: ReactElement) => ReactNode;
  /**
   * False leaves web addresses as plain text, not links: someone the user
   * hasn't accepted yet (a message request) can't be followed with a click
   * (Signal Desktop does the same). Default true.
   */
  linksEnabled?: boolean;
}

/** Plain text with http(s) links, and bare domains, made clickable (opened in a new tab, no referrer). */
function Linkified({ text, enabled = true }: { text: string; enabled?: boolean }) {
  if (!enabled) return text;
  const links = findLinks(text);
  if (links.length === 0) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const link of links) {
    if (link.start > last) parts.push(text.slice(last, link.start));
    parts.push(
      <a
        key={link.start}
        className={styles.link}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        {link.text}
      </a>,
    );
    last = link.end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** `Linkified`, with any resolvable `:name:` custom emoji swapped for its image. */
function EmojiAndLinks({
  text,
  resolve,
  wrap,
  links,
}: {
  text: string;
  resolve: (name: string) => string | undefined;
  wrap?: ((name: string, image: ReactElement) => ReactNode) | undefined;
  links: boolean;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CUSTOM_EMOJI_TOKEN)) {
    const name = match[1];
    const dataUrl = name && resolve(name);
    if (!dataUrl) continue;
    const at = match.index;
    if (at > last) parts.push(<Linkified key={at} text={text.slice(last, at)} enabled={links} />);
    const image = <img className={styles.customEmoji} src={dataUrl} alt={match[0]} />;
    parts.push(
      wrap && name ? (
        <Fragment key={`${at}e`}>{wrap(name, image)}</Fragment>
      ) : (
        cloneElement(image, { key: `${at}e` })
      ),
    );
    last = at + match[0].length;
  }
  if (last === 0) return <Linkified text={text} enabled={links} />;
  if (last < text.length)
    parts.push(<Linkified key={last} text={text.slice(last)} enabled={links} />);
  return parts;
}

/** Click (or Enter/Space) to reveal; stays revealed. */
function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (revealed)
    return (
      <span className={styles.spoiler} data-revealed="">
        {children}
      </span>
    );
  const reveal = () => {
    setRevealed(true);
  };
  return (
    <span
      className={styles.spoiler}
      role="button"
      tabIndex={0}
      aria-label="Spoiler, activate to reveal"
      onClick={(e) => {
        e.stopPropagation();
        reveal();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          reveal();
        }
      }}
    >
      {/* inert: hidden content can't be focused or clicked (a link under the bar would follow). */}
      <span aria-hidden inert className={styles.spoilerText}>
        {children}
      </span>
    </span>
  );
}

function plainText(segments: readonly Segment[]): string {
  return segments
    .map((s) =>
      s.type === 'text' ? s.text : s.type === 'mention' ? s.text : plainText(s.children),
    )
    .join('');
}

function render(segments: readonly Segment[], props: MessageBodyProps, path: string): ReactNode[] {
  return segments.map((s, i) => {
    const key = `${path}.${i}`;
    if (s.type === 'text') {
      // Stray placeholders (a mention without its range) carry no meaning.
      const text = s.text.replaceAll(MENTION_PLACEHOLDER, '');
      if (props.preview) return text;
      return props.resolveCustomEmoji ? (
        <EmojiAndLinks
          key={key}
          text={text}
          resolve={props.resolveCustomEmoji}
          wrap={props.renderCustomEmoji}
          links={props.linksEnabled !== false}
        />
      ) : (
        <Linkified key={key} text={text} enabled={props.linksEnabled !== false} />
      );
    }
    if (s.type === 'mention') {
      if (props.preview)
        return (
          <span
            key={key}
            className={styles.mention}
            data-self={s.mentionId === props.selfId ? '' : undefined}
          >
            @{props.nameFor(s.mentionId)}
          </span>
        );
      const pill = (
        <button
          type="button"
          className={styles.mention}
          data-self={s.mentionId === props.selfId ? '' : undefined}
        >
          @{props.nameFor(s.mentionId)}
        </button>
      );
      return (
        <span key={key}>{props.renderMention ? props.renderMention(s.mentionId, pill) : pill}</span>
      );
    }
    switch (s.style) {
      case 'bold':
        return <strong key={key}>{render(s.children, props, key)}</strong>;
      case 'italic':
        return <em key={key}>{render(s.children, props, key)}</em>;
      case 'strikethrough':
        return <s key={key}>{render(s.children, props, key)}</s>;
      case 'spoiler':
        if (props.preview)
          return (
            <span key={key} className={styles.spoiler}>
              {/* inert: hidden content can't be focused or clicked (a link under the bar would follow). */}
              <span aria-hidden inert className={styles.spoilerText}>
                {render(s.children, props, key)}
              </span>
            </span>
          );
        return <Spoiler key={key}>{render(s.children, props, key)}</Spoiler>;
      case 'monospace': {
        const code = plainText(s.children);
        if (code.includes('\n')) {
          return (
            <pre key={key} className={styles.block}>
              <code>{code.replace(/^\n+|\n+$/gu, '')}</code>
            </pre>
          );
        }
        return (
          <code key={key} className={styles.code}>
            {code}
          </code>
        );
      }
    }
  });
}

/**
 * One emoji grapheme: a pictograph shown as an emoji with its modifiers and
 * ZWJ parts, a flag (two regional indicators), or a keycap. Bare digits, `#`
 * and `*` are emoji components in Unicode but plain text on their own, so "2"
 * is never jumbo. Neither are the pictographs that render as text unless
 * followed by U+FE0F (©, ™, ↔, ▶, a bare ❤): without the emoji presentation
 * selector (or a skin tone) they are ordinary characters.
 */
const JUMBO_GRAPHEME =
  /^(?:\p{Extended_Pictographic}(?:(?<=\p{Emoji_Presentation})|\ufe0f|(?=\p{Emoji_Modifier}))(?:\p{Emoji_Component}|\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}|[0-9#*]\ufe0f?\u20e3)$/u;
/** A standin pictographic char so a resolved `:name:` token counts as one jumbo-eligible unit. */
const JUMBO_PLACEHOLDER = '🟡';

/**
 * Up to 10 emoji and nothing else are shown large, as in most chat apps.
 * `resolveCustomEmoji` lets the same rule count the viewer's own resolvable
 * `:name:` tokens as emoji too; an unresolved token is just text, so it never
 * triggers jumbo (consistent with never guessing another sender's emoji).
 */
export function isJumbo(
  body: string,
  ranges: readonly BodyRange[],
  resolveCustomEmoji?: (name: string) => string | undefined,
): boolean {
  if (ranges.length > 0 || body.trim() === '') return false;
  const trimmed = body.trim();
  const withPlaceholders = resolveCustomEmoji
    ? trimmed.replaceAll(CUSTOM_EMOJI_TOKEN, (token, name: string) =>
        resolveCustomEmoji(name) ? JUMBO_PLACEHOLDER : token,
      )
    : trimmed;
  const graphemes = splitGraphemes(withPlaceholders).filter((g) => g.trim() !== '');
  return graphemes.length <= 10 && graphemes.every((g) => JUMBO_GRAPHEME.test(g));
}

/** Renders a Signal body with its native formatting, mentions and spoilers. */
export const MessageBody = memo(function MessageBody(props: MessageBodyProps) {
  const { body, ranges, className } = props;
  const segments = rangesToSegments(body, ranges);
  return (
    <div
      {...(props.id !== undefined ? { id: props.id } : {})}
      className={[styles.body, className].filter(Boolean).join(' ')}
      data-snowdrop="message-body"
      data-jumbo={isJumbo(body, ranges, props.resolveCustomEmoji) ? '' : undefined}
      dir="auto"
    >
      {render(segments, props, 'b')}
      {props.trailing}
    </div>
  );
});
