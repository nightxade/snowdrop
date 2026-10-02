/**
 * Native drag and drop of conversations (sidebar row → rail tile / category).
 * Native DnD crosses components without a shared dnd-kit context, so the rail
 * and the sidebar stay independent (and dnd-kit stays lazy). Keyboard users
 * have the same moves in the row's menu ("Move to space", "Move to category").
 */
import { useState, type DragEvent } from 'react';

export const CONVERSATION_MIME = 'application/x-shrike-conversation';

export function startConversationDrag(e: DragEvent, conversationId: string): void {
  e.dataTransfer.setData(CONVERSATION_MIME, conversationId);
  e.dataTransfer.effectAllowed = 'move';
}

export function isConversationDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(CONVERSATION_MIME);
}

export interface ConversationDropTarget {
  active: boolean;
  handlers: {
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}

/** Drop-target props + an "a conversation is over me" flag for highlighting. */
export function useConversationDrop(
  onDrop: (conversationId: string) => void,
  enabled = true,
): ConversationDropTarget {
  const [active, setActive] = useState(false);
  const accept = (e: DragEvent) => {
    if (!enabled || !isConversationDrag(e)) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return true;
  };
  return {
    active,
    handlers: {
      onDragEnter: (e) => {
        if (accept(e)) setActive(true);
      },
      onDragOver: (e) => {
        accept(e);
      },
      onDragLeave: (e) => {
        // Ignore leaving into a child of the target.
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)))
          setActive(false);
      },
      onDrop: (e) => {
        setActive(false);
        if (!accept(e)) return;
        const id = e.dataTransfer.getData(CONVERSATION_MIME);
        if (id) onDrop(id);
      },
    },
  };
}
