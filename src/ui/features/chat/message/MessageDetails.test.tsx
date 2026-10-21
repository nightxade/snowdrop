import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { messageId, type Message } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { MessageDetails } from './MessageDetails';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

async function setup() {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  const selfId = snowdrop.stores.session.getState().self!.id;
  const [alice, bob, carol] = conv.memberIds.filter((id) => id !== selfId);
  return { snowdrop, conv, selfId, alice: alice!, bob: bob!, carol: carol! };
}

function outgoingMessage(conversationId: string, selfId: string, sentAt: number): Message {
  return {
    id: messageId(selfId, sentAt),
    conversationId: conversationId as Message['conversationId'],
    authorId: selfId,
    sentAt,
    receivedAt: sentAt,
    body: 'status check',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read',
    kind: 'normal',
  };
}

describe('<MessageDetails />', () => {
  it('groups recipients into Read by / Delivered to / Sent to / Not delivered, with names and times', async () => {
    const { snowdrop, conv, selfId, alice, bob, carol } = await setup();
    const sentAt = Date.now();
    const message: Message = {
      ...outgoingMessage(conv.id, selfId, sentAt),
      receipts: {
        [alice]: { status: 'read', at: sentAt + 1_000 },
        [bob]: { status: 'delivered', at: sentAt + 500 },
      },
      failedRecipients: [carol],
    };
    const aliceName = snowdrop.stores.contacts.getState().byId[alice]!.name;
    const bobName = snowdrop.stores.contacts.getState().byId[bob]!.name;
    const carolName = snowdrop.stores.contacts.getState().byId[carol]!.name;

    renderWithSnowdrop(
      snowdrop,
      <MessageDetails message={message} onOpenChange={() => undefined} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Message details' });
    expect(within(dialog).getByText('Read by')).toBeTruthy();
    expect(within(dialog).getByText(aliceName)).toBeTruthy();
    expect(within(dialog).getByText('Delivered to')).toBeTruthy();
    expect(within(dialog).getByText(bobName)).toBeTruthy();
    expect(within(dialog).getByText('Not delivered')).toBeTruthy();
    expect(within(dialog).getByText(carolName)).toBeTruthy();
  });

  it('shows read receipts as delivered while the phone has read receipts off', async () => {
    const { snowdrop, conv, selfId, alice } = await setup();
    snowdrop.stores.session.getState().setPhonePrivacy({
      status: 'ready',
      values: {
        readReceipts: false,
        typingIndicators: null,
        linkPreviews: null,
        unidentifiedDeliveryIndicators: null,
      },
    });
    const sentAt = Date.now();
    const message: Message = {
      ...outgoingMessage(conv.id, selfId, sentAt),
      receipts: { [alice]: { status: 'read', at: sentAt + 1_000 } },
    };
    renderWithSnowdrop(
      snowdrop,
      <MessageDetails message={message} onOpenChange={() => undefined} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Message details' });
    expect(within(dialog).queryByText('Read by')).toBeNull();
    expect(within(dialog).getByText('Delivered to')).toBeTruthy();
  });

  it('shows the one recipient for a DM, under "Sent to" when no receipt has arrived yet', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.kind === 'direct',
    )!;
    const selfId = snowdrop.stores.session.getState().self!.id;
    const peer = conv.memberIds.find((id) => id !== selfId)!;
    const peerName = snowdrop.stores.contacts.getState().byId[peer]!.name;
    const sentAt = Date.now();
    const message = outgoingMessage(conv.id, selfId, sentAt);

    renderWithSnowdrop(
      snowdrop,
      <MessageDetails message={message} onOpenChange={() => undefined} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Message details' });
    expect(within(dialog).getByText('Sent to')).toBeTruthy();
    expect(within(dialog).getByText(peerName)).toBeTruthy();
    expect(within(dialog).queryByText('Read by')).toBeNull();
  });
});
