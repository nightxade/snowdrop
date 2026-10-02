import { useState, type DragEvent } from 'react';
import type { ConversationId } from '@/core/domain';
import { CONVERSATION_MIME, isConversationDrag, useStores } from '@/ui/hooks';
import { renderedInsertIndex, storeInsertIndex } from './dropIndex';

export interface DropIndicator {
  categoryId: string;
  /** Insertion point among the rendered rows of that category. */
  index: number;
}

/**
 * Drop handling for a space's categories: a line shows where the row will
 * land; dropping moves it there (between categories too).
 */
export function useCategoryDrop(spaceId: string) {
  const stores = useStores();
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);

  const locate = (e: DragEvent<HTMLElement>, categoryId: string): DropIndicator => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row-id]')];
    const middles = rows.map((r) => {
      const box = r.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    return { categoryId, index: renderedInsertIndex(middles, e.clientY) };
  };

  const handlers = (categoryId: string, renderedIds: readonly string[]) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!isConversationDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const next = locate(e, categoryId);
      setIndicator((cur) =>
        cur?.categoryId === next.categoryId && cur.index === next.index ? cur : next,
      );
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)))
        setIndicator((cur) => (cur?.categoryId === categoryId ? null : cur));
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!isConversationDrag(e)) return;
      e.preventDefault();
      const id = e.dataTransfer.getData(CONVERSATION_MIME) as ConversationId;
      const at = locate(e, categoryId);
      setIndicator(null);
      const space = stores.spaces.getState().spaces[spaceId];
      const category = space?.categories.find((c) => c.id === categoryId);
      if (!id || !category) return;
      stores.spaces
        .getState()
        .moveConversation(
          id,
          categoryId,
          storeInsertIndex(category.conversationIds, renderedIds, at.index, id),
        );
    },
  });

  return {
    indicator,
    handlers,
    clear: () => {
      setIndicator(null);
    },
  };
}
