import type { OutgoingAttachment } from '@/core/backend';
import type { ConversationId, Quote } from '@/core/domain';
import { createLogger } from '@/core/lib';

/**
 * What the composer hands to the send pipeline: raw markdown text with a
 * U+FFFC placeholder per mention and the mentioned ids in document order.
 * Plugin transforms see and return this shape.
 */
export interface OutgoingDraft {
  conversationId: ConversationId;
  text: string;
  mentionIds: string[];
  quote?: Quote;
  attachments: OutgoingAttachment[];
  /**
   * How to interpret `text`. Omitted = follow the user's markdown setting.
   * Generated text (slash commands) that relies on escaping says 'markdown'
   * explicitly so it renders correctly even with markdown turned off.
   */
  format?: 'markdown' | 'plain';
}

/** Structural check for drafts coming back from (untrusted) plugin transforms. */
export function isValidDraft(value: unknown, original: OutgoingDraft): value is OutgoingDraft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Partial<Record<keyof OutgoingDraft, unknown>>;
  return (
    d.conversationId === original.conversationId &&
    typeof d.text === 'string' &&
    Array.isArray(d.mentionIds) &&
    d.mentionIds.every((id) => typeof id === 'string') &&
    Array.isArray(d.attachments) &&
    (d.format === undefined || d.format === 'markdown' || d.format === 'plain')
  );
}

/**
 * Extension hooks the send pipeline consults. Implemented by the plugin
 * registries; kept as an interface so services don't depend on plugins.
 */
export interface DraftPipeline {
  /** Runs outgoing transforms (errors in one transform must not block sending). */
  transform(draft: OutgoingDraft): Promise<OutgoingDraft>;
  /** False when some extension suppresses typing indicators for this conversation. */
  allowsTyping(conversationId: ConversationId): boolean;
}

export const PASSTHROUGH_PIPELINE: DraftPipeline = {
  transform: (draft) => Promise.resolve(draft),
  allowsTyping: () => true,
};

export type ErrorReporter = (error: unknown, context: string) => void;

const log = createLogger('app');

/** The default `onError` for services that don't get one: logs at scope `app`. */
export const consoleReporter: ErrorReporter = (error, context) => {
  log.error(context, error);
};
