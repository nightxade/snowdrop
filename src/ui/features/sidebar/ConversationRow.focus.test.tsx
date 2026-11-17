import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ConversationList } from './ConversationList';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('clicking a sidebar row', () => {
  it('focuses it at once: WebKitGTK does not focus a button on click, and a click here does not either', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <ConversationList />);
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[data-conversation-id][data-roving-item]'),
    ];
    const target = rows[3]!;
    // A click event on a button leaves focus alone, as in WebKitGTK.
    expect(document.activeElement).not.toBe(target);
    fireEvent.click(target);
    expect(document.activeElement).toBe(target);
  });
});
