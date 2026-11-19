import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { useStores } from '@/ui/hooks';

/**
 * Closes an edit whose message was deleted, here or on another device, saying so. Focus stays
 * where the user left it, unless it was in the editor: then it goes to the message's row (a
 * deleted message keeps its row), or to the composer when the row went with the message.
 */
export function useEditGuard(conversationId: ConversationId, focusComposer: () => void): void {
  const stores = useStores();
  const id = useStore(stores.ui, (s) =>
    s.editing?.conversationId === conversationId ? s.editing.messageId : undefined,
  );
  const deleted = useStore(stores.messages, (s) =>
    id ? s.windows[conversationId]?.byId[id]?.deleted === true : false,
  );
  const removed = useStore(stores.messages, (s) => (id ? s.gone[id] === true : false));
  useEffect(() => {
    if (!id || !(deleted || removed)) return;
    const row = removed
      ? null
      : document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    const active = document.activeElement;
    // In the editor, which was inside the row (still, or until the row went); or nowhere at all.
    const heldFocus =
      !active ||
      active === document.body ||
      (active instanceof HTMLElement &&
        active.closest('[data-message-id]')?.getAttribute('data-message-id') === id);
    const ui = stores.ui.getState();
    ui.setEditing(null);
    ui.pushToast({ message: 'This message was deleted', kind: 'info', source: 'core' });
    if (!heldFocus) return;
    if (row) row.focus();
    else focusComposer();
  }, [stores, id, deleted, removed, focusComposer]);
}
