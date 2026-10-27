import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { directConversationId, type Message } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { MessageItem } from './MessageItem';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

it('a message a changed safety number stopped offers Review safety number beside Retry', async () => {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const mock = (await snowdrop.backendReady) as MockBackend;
  const annika = mock.world.personIds.get('annika')!;
  const dm = directConversationId(annika);
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(dm);
    await snowdrop.history.open(dm);
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await act(async () => {
    await snowdrop.send.send({
      conversationId: dm,
      text: 'hello',
      mentionIds: [],
      attachments: [],
    });
  });
  const selfId = snowdrop.stores.session.getState().self!.id;
  const own: Message = messagesSelectors
    .list(dm)(snowdrop.stores.messages.getState())
    .findLast((m) => m.authorId === selfId)!;
  expect(own).toMatchObject({ status: 'failed', blockedByIdentity: [annika] });
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <div data-snowdrop="message-log">
        <MessageItem
          conversationId={dm}
          id={own.id}
          continuation={false}
          compact={false}
          compactAvatars={false}
        />
      </div>
    </ChatControllerProvider>,
  );
  const row = screen.getByRole('article');
  expect(within(row).getByRole('button', { name: 'Retry' })).toBeTruthy();
  snowdrop.stores.ui.getState().closeModal();
  fireEvent.click(within(row).getByRole('button', { name: 'Review safety number' }));
  await act(async () => {
    await new Promise((r) => {
      requestAnimationFrame(() => {
        r(undefined);
      });
    });
  });
  expect(snowdrop.stores.ui.getState().modal).toMatchObject({
    type: 'safetyNumberChange',
    props: { conversationId: dm, nonce: own.nonce, contactIds: [annika] },
  });
});

it('a plain failed send has no safety number action', async () => {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const mock = (await snowdrop.backendReady) as MockBackend;
  const dm = directConversationId(mock.world.personIds.get('ines')!);
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(dm);
    await snowdrop.history.open(dm);
  });
  mock.failNext();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await act(async () => {
    await snowdrop.send.send({
      conversationId: dm,
      text: 'hello',
      mentionIds: [],
      attachments: [],
    });
  });
  const selfId = snowdrop.stores.session.getState().self!.id;
  const own = messagesSelectors
    .list(dm)(snowdrop.stores.messages.getState())
    .findLast((m) => m.authorId === selfId)!;
  expect(own.blockedByIdentity).toBeUndefined();
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={new ChatController()}>
      <div data-snowdrop="message-log">
        <MessageItem
          conversationId={dm}
          id={own.id}
          continuation={false}
          compact={false}
          compactAvatars={false}
        />
      </div>
    </ChatControllerProvider>,
  );
  expect(screen.queryByRole('button', { name: 'Review safety number' })).toBeNull();
});
