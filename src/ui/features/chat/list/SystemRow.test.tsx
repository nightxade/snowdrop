import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { directConversationId, messageId, systemMessageId, type Message } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatControllerProvider, type ChatController } from '../ChatController';
import { SystemRow } from './SystemRow';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

async function withLine(withAction: boolean) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const mock = (await snowdrop.backendReady) as MockBackend;
  const ines = mock.world.personIds.get('ines')!;
  const dm = directConversationId(ines);
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(dm);
    await snowdrop.history.open(dm);
  });
  const sentAt = Date.now() + 1000;
  const line: Message = {
    id: systemMessageId(ines, sentAt, 'decrypt'),
    conversationId: dm,
    authorId: ines,
    sentAt,
    receivedAt: sentAt,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'sent',
    kind: 'system',
    systemText: 'Safety Number with Ines Okafor has changed',
    ...(withAction ? { systemAction: { kind: 'safety-number', contactId: ines } as const } : {}),
  };
  snowdrop.stores.messages.getState().appendLive(line);
  const view = renderWithSnowdrop(snowdrop, <SystemRow conversationId={dm} id={line.id} />);
  return { snowdrop, ines, view };
}

describe('<SystemRow /> safety number line', () => {
  it('shows View Safety Number, which opens that person’s number, and passes axe', async () => {
    const second = await withLine(true);
    const ines = second.ines;
    const row = screen.getByText('Safety Number with Ines Okafor has changed').closest('div')!;
    expect((await axe(row)).violations).toEqual([]);
    fireEvent.click(within(row).getByRole('button', { name: 'View Safety Number' }));
    await act(async () => {
      await new Promise((r) => {
        requestAnimationFrame(() => {
          r(undefined);
        });
      });
    });
    await settle(second.snowdrop);
    expect(second.snowdrop.stores.ui.getState().modal).toMatchObject({
      type: 'safetyNumber',
      props: { contactId: ines },
    });
  });

  it('has no button on an ordinary system line', async () => {
    await withLine(false);
    expect(screen.queryByRole('button', { name: 'View Safety Number' })).toBeNull();
  });
});

describe('<SystemRow /> pin line', () => {
  it('has a keyboard-reachable Go to message button that reveals the pinned message', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const mock = (await snowdrop.backendReady) as MockBackend;
    const ines = mock.world.personIds.get('ines')!;
    const dm = directConversationId(ines);
    await act(async () => {
      snowdrop.stores.ui.getState().selectConversation(dm);
      await snowdrop.history.open(dm);
    });
    const sentAt = Date.now() + 1000;
    const target = messageId(ines, sentAt - 5);
    const line: Message = {
      id: systemMessageId(ines, sentAt, 'pin'),
      conversationId: dm,
      authorId: ines,
      sentAt,
      receivedAt: sentAt,
      body: '',
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'sent',
      kind: 'system',
      systemText: 'Ines Okafor pinned a message',
      systemAction: { kind: 'go-to-message', messageId: target },
    };
    snowdrop.stores.messages.getState().appendLive(line);
    const reveal = vi.fn(() => Promise.resolve(true));
    const chat = { reveal } as unknown as ChatController;
    renderWithSnowdrop(
      snowdrop,
      <ChatControllerProvider value={chat}>
        <SystemRow conversationId={dm} id={line.id} />
      </ChatControllerProvider>,
    );
    const button = screen.getByRole('button', { name: 'Go to message' });
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(reveal).toHaveBeenCalledWith(dm, target);
  });
});
