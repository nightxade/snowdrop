import { act, cleanup, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { ConversationId } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { useReleaseMarkedUnread } from './useReleaseMarkedUnread';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

function Column({ id }: { id: ConversationId }) {
  const ref = useRef<HTMLElement | null>(null);
  useReleaseMarkedUnread(ref, id);
  return (
    <main ref={ref}>
      <div data-testid="list" />
      <input data-testid="field" />
    </main>
  );
}

describe('useReleaseMarkedUnread', () => {
  it('ends the hold on the first scroll, key or press inside the chat, not before', async () => {
    snowdrop = await bootSnowdrop();
    const id = Object.values(snowdrop.stores.conversations.getState().byId)[0]!.id;
    const marked = () => snowdrop!.stores.local.getState().conversations[id]?.markedUnread;
    const view = renderWithSnowdrop(snowdrop, <Column id={id} />);
    for (const fire of [
      (el: Element) => fireEvent.wheel(el),
      (el: Element) => fireEvent.keyDown(el, { key: 'x' }),
      (el: Element) => fireEvent.pointerDown(el),
    ]) {
      act(() => {
        snowdrop!.stores.local.getState().setMarkedUnread(id, true);
      });
      expect(marked()).toBe(true);
      fire(view.getByTestId('list'));
      expect(marked()).toBeUndefined();
    }
  });
});
