import { Image as ImageIcon, Sticker as StickerIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useStore } from 'zustand';
import { bodyToPlainText, type ConversationId, type Quote } from '@/core/domain';
import { contactsSelectors, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { PersonAvatar } from '@/ui/features/conversation';
import { describeAttachment } from '../lib/attachments';
import styles from './QuoteHeader.module.css';

export interface QuoteHeaderProps {
  quote: Quote;
  nameFor: (id: string) => string;
  onJump: () => void;
  compact?: boolean;
  /** The conversation the reply is in (a stranger's photo stays hidden until it's accepted). */
  conversationId?: ConversationId;
}

/** "↱ (avatar) Name  snippet" above a reply; click jumps to and flashes the original. */
export function QuoteHeader({ quote, nameFor, onJump, compact, conversationId }: QuoteHeaderProps) {
  const stores = useStores();
  const author = useStore(stores.contacts, contactsSelectors.contact(quote.authorId));
  const name = author?.name ?? UNKNOWN_CONTACT_NAME;
  const text = bodyToPlainText(quote.text, quote.ranges ?? [], nameFor)
    .replace(/\s+/gu, ' ')
    .trim();
  const firstAttachment = quote.attachments?.[0];
  return (
    <div
      className={styles.quote}
      data-compact={compact ? '' : undefined}
      data-snowdrop="message-quote"
    >
      <span className={styles.connector} aria-hidden />
      <button
        type="button"
        className={styles.button}
        onClick={(e) => {
          e.stopPropagation();
          onJump();
        }}
        aria-label={`Reply to ${name}: ${clip(text || (quote.sticker ? 'sticker' : 'attachment'), 80)} (jump to message)`}
      >
        <PersonAvatar
          size={16}
          contactId={quote.authorId}
          conversationId={conversationId}
          // Too small for legible initials: a plain colour dot.
          fallback=""
          color={author?.color ?? 'var(--snowdrop-avatar-1)'}
        />
        <span
          className={styles.name}
          style={
            { '--name-color': author?.color ?? 'var(--snowdrop-text-strong)' } as CSSProperties
          }
        >
          {name}
        </span>
        {text ? (
          <span className={styles.text}>{text}</span>
        ) : (
          <span className={styles.text} data-italic="">
            {quote.sticker ? (
              <>
                {quote.sticker.emoji ? (
                  <span aria-hidden>{quote.sticker.emoji}</span>
                ) : (
                  <StickerIcon size={14} aria-hidden />
                )}{' '}
                Sticker
              </>
            ) : firstAttachment ? (
              <>
                <ImageIcon size={14} aria-hidden /> {describeAttachment(firstAttachment)}
              </>
            ) : (
              'Click to see the original message'
            )}
          </span>
        )}
      </button>
    </div>
  );
}

/** Keeps the accessible name short; a quote's full text is on screen in the original. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
