import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ConversationList } from './ConversationList';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('sidebar rows for message requests', () => {
  it('marks a request with "Message request" instead of its preview, and others keep theirs', async () => {
    snowdrop = await bootSnowdrop();
    const mock = (await snowdrop.backendReady) as MockBackend;
    const dm = mock.world.conversationIds.get('request-dm')!;
    const group = mock.world.conversationIds.get('request-group')!;
    renderWithSnowdrop(snowdrop, <ConversationList />);
    const row = (id: string) =>
      document.querySelector<HTMLElement>(`[data-conversation-id="${id}"]`)!.closest('li')!;
    for (const id of [dm, group]) {
      expect(within(row(id)).getByText('Message request')).toBeTruthy();
      expect(row(id).hasAttribute('data-request')).toBe(true);
      expect(row(id).querySelector('button')?.getAttribute('aria-label')).toMatch(
        /message request/u,
      );
    }
    // The stranger's words never reach the list.
    expect(row(dm).textContent).not.toContain('pottery studio');
    // An ordinary chat is untouched.
    const others = [
      ...document.querySelectorAll<HTMLElement>('li[data-snowdrop="conversation-row"]'),
    ].filter((li) => li !== row(dm) && li !== row(group));
    expect(others.length).toBeGreaterThan(5);
    for (const li of others) {
      expect(li.hasAttribute('data-request')).toBe(false);
      expect(within(li).queryByText('Message request')).toBeNull();
    }
  });

  it('shows the real preview once the request is accepted, and "Blocked" while blocked', async () => {
    snowdrop = await bootSnowdrop();
    const mock = (await snowdrop.backendReady) as MockBackend;
    const dm = mock.world.conversationIds.get('request-dm')!;
    renderWithSnowdrop(snowdrop, <ConversationList />);
    const row = () =>
      document.querySelector<HTMLElement>(`[data-conversation-id="${dm}"]`)!.closest('li')!;
    await act(async () => {
      await snowdrop!.requests.block(dm);
    });
    await settle(snowdrop);
    expect(within(row()).getByText('Blocked')).toBeTruthy();
    expect(row().hasAttribute('data-request')).toBe(false);
    await act(async () => {
      await snowdrop!.requests.unblock(dm);
    });
    await settle(snowdrop);
    expect(within(row()).queryByText('Blocked')).toBeNull();
    expect(within(row()).queryByText('Message request')).toBeNull();
    expect(row().textContent).toContain('Here is my last attempt');
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
  });
});
