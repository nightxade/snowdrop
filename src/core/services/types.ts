import type { OutgoingAttachment } from '@/core/backend';
import type { ConversationId, Quote } from '@/core/domain';

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

export const consoleReporter: ErrorReporter = (error, context) => {
  console.error(`[hearth] ${context}`, error);
};
