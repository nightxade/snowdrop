import { lazy, Suspense } from 'react';
import type { ConversationId } from '@/core/domain';
import { useConversationView } from '@/ui/features/conversation';
import { Drawer } from '@/ui/primitives';
import { useChatController } from './ChatController';
import styles from './ConversationArea.module.css';

// Fetched the first time someone opens a conversation's media.
const GalleryPanel = lazy(() =>
  import('./gallery/GalleryPanel').then((m) => ({ default: m.GalleryPanel })),
);

const galleryToggle = () => document.querySelector<HTMLElement>('[data-snowdrop="gallery-toggle"]');

/** "Media, files & links" beside the conversation: inline when wide, a sheet when narrow, like search. */
export function GallerySlot({
  conversationId,
  narrow,
}: {
  conversationId: ConversationId;
  narrow: boolean;
}) {
  const chat = useChatController();
  const conversation = useConversationView(conversationId);
  if (!conversation) return null;
  const close = () => {
    chat.setGalleryOpen(false);
    // The drawer hands focus back itself; inline, the header button that opens this is the home.
    if (!narrow) galleryToggle()?.focus();
  };
  const panel = (
    <Suspense fallback={null}>
      <GalleryPanel
        key={conversationId}
        conversation={conversation}
        onClose={close}
        closeOnJump={narrow}
      />
    </Suspense>
  );
  if (!narrow)
    return (
      <div className={styles.side} data-tui-flatten>
        {panel}
      </div>
    );
  return (
    <Drawer
      side="right"
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      label="Media, files and links"
      returnFocus={galleryToggle}
    >
      {panel}
    </Drawer>
  );
}
