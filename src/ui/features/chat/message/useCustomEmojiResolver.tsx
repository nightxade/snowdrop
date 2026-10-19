import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ConversationId, Message } from '@/core/domain';
import { useStores } from '@/ui/hooks';
import { useAttachmentUrl } from './useAttachmentUrl';

type Resolve = (name: string) => string | undefined;

/**
 * How a message's `:name:` tokens become inline images (MessageBody's
 * `resolveCustomEmoji`). Your own messages use your own collection, which is
 * what was sent. Received messages use only the emoji delivered with that
 * message (patches/signal-cli's custom-emoji extension, docs/SIGNAL_CLI.md),
 * never your collection, which says nothing about what the sender meant.
 *
 * Delivered emoji download through the normal attachment path, one hidden
 * `EmojiSource` each (a hook can't run once per item of a list), so the
 * caller renders `emojiSources` somewhere in the message. Until an image is
 * ready its token stays plain text.
 */
export function useCustomEmojiResolver(
  message: Message,
  selfId: string | null,
  conversationId: ConversationId,
): { resolveCustomEmoji: Resolve | undefined; emojiSources: ReactNode } {
  const stores = useStores();
  const collection = useStore(stores.local, (s) => s.customEmoji);
  const own = message.authorId === selfId;
  const delivered = own ? undefined : message.customEmoji;
  const [urls, setUrls] = useState<Readonly<Record<string, string>>>({});

  const onResolved = useCallback((name: string, url: string | undefined) => {
    setUrls((current) => {
      if (current[name] === url) return current;
      if (url !== undefined) return { ...current, [name]: url };
      const { [name]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const resolveCustomEmoji = useMemo<Resolve | undefined>(() => {
    // A text emoticon's `:name:` was already expanded to its text when this
    // (our own) message was sent, so only an *image* emoji can still be
    // behind a surviving token — never a text emoji's name.
    if (own)
      return (name) => {
        const emoji = collection.find((e) => e.name === name);
        return emoji?.kind === 'image' ? emoji.dataUrl : undefined;
      };
    if (!delivered?.length) return undefined;
    return (name) => urls[name];
  }, [own, collection, delivered, urls]);

  const emojiSources = delivered?.map((e) => (
    <EmojiSource
      key={e.name}
      conversationId={conversationId}
      message={message}
      name={e.name}
      attachment={e.attachment}
      onResolved={onResolved}
    />
  ));

  return { resolveCustomEmoji, emojiSources };
}

/** Downloads one delivered emoji and reports its URL (or `undefined` until ready). */
function EmojiSource({
  conversationId,
  message,
  name,
  attachment,
  onResolved,
}: {
  conversationId: ConversationId;
  message: Pick<Message, 'authorId' | 'sentAt'>;
  name: string;
  attachment: Message['attachments'][number];
  onResolved: (name: string, url: string | undefined) => void;
}) {
  const state = useAttachmentUrl(conversationId, message, attachment);
  const url = state.status === 'ready' ? state.url : undefined;
  useEffect(() => {
    onResolved(name, url);
  }, [name, url, onResolved]);
  return null;
}
