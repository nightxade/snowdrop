import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { directConversationId } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { buildMessageMenu } from './messageMenu';
import { MessageItem } from './MessageItem';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

async function failedSend(error?: Error) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const mock = (await snowdrop.backendReady) as MockBackend;
  const dm = directConversationId(mock.world.personIds.get('ines')!);
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(dm);
    await snowdrop.history.open(dm);
  });
  if (error) mock.failNext(error);
  else mock.failNext();
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
  const menuLabel = (): string | undefined => {
    const entries = buildMessageMenu(
      snowdrop,
      new ChatController(),
      messagesSelectors
        .list(dm)(snowdrop.stores.messages.getState())
        .find((m) => m.id === own.id)!,
      {
        openPicker: () => undefined,
        requestDelete: () => undefined,
        openDetails: () => undefined,
        requestEndPoll: () => undefined,
        openStickerPack: () => undefined,
        openCustomEmoji: () => undefined,
      },
    );
    const retry = entries.find((e) => e.kind === 'item' && e.id === 'retry');
    return retry?.kind === 'item' ? retry.label : undefined;
  };
  return {
    ...within(screen.getByRole('article')),
    article: screen.getByRole('article'),
    menuLabel,
  };
}

it('a send that timed out says it may have sent and offers Send again, not Retry', async () => {
  const row = await failedSend(Object.assign(new Error('no answer'), { kind: 'timeout' }));
  expect(row.getByText('May have sent')).toBeTruthy();
  expect(row.getByRole('button', { name: 'Send again' })).toBeTruthy();
  expect(row.queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(row.queryByText('Failed to send')).toBeNull();
});

it('an ordinary failed send still says Failed to send with Retry', async () => {
  const row = await failedSend();
  expect(row.getByText('Failed to send')).toBeTruthy();
  expect(row.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

it('the context menu words a timed-out send like the row does, and a plain failure as before', async () => {
  const timedOut = await failedSend(Object.assign(new Error('no answer'), { kind: 'timeout' }));
  expect(timedOut.menuLabel()).toBe('Send again (may have sent)');
  cleanup();
  const plain = await failedSend();
  expect(plain.menuLabel()).toBe('Retry sending');
});

it('the failed-send notes have no accessibility violations, plain or unconfirmed', async () => {
  const timedOut = await failedSend(Object.assign(new Error('no answer'), { kind: 'timeout' }));
  expect((await axe(timedOut.article)).violations.map((v) => v.id)).toEqual([]);
  cleanup();
  const plain = await failedSend();
  expect((await axe(plain.article)).violations.map((v) => v.id)).toEqual([]);
});
