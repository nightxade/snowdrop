/**
 * The quiet no-history note at the top of a conversation: signal-cli can't
 * transfer message history from before this device was linked, so the UI
 * says so once there's nothing older to load. Demo conversations have no
 * such gap, so the note must never appear there.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createSnowdrop, type Snowdrop } from '@/app/createSnowdrop';
import { SnowdropProvider } from '@/app/SnowdropProvider';
import { SELF_ACI, SELF_NUMBER } from '@/core/backend/signal-cli/fixtures/envelopes';
import { FakeDaemon, flush } from '@/core/backend/signal-cli/testing';
import { directConversationId } from '@/core/domain';
import { createMemoryStorage, MemoryMessageRepository } from '@/core/persistence';
import { bootSnowdrop } from '@/test/renderWithSnowdrop';
import { ConversationIntro } from './ConversationIntro';

const NOTE = 'Messages from before you linked Snowdrop aren’t available on this computer.';

async function bootSignalCliSnowdrop(): Promise<Snowdrop> {
  const daemon = new FakeDaemon()
    .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
    .reply('listContacts', [])
    .reply('listGroups', []);
  // The backend instance is picked from settings at createSnowdrop() time
  // (app/backends.ts), so the connection must already be in storage —
  // updating the settings store afterwards would only relabel the UI, not
  // swap the running backend.
  const storage = createMemoryStorage({
    'snowdrop.settings': JSON.stringify({
      v: 2,
      data: {
        connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: SELF_ACI },
      },
    }),
  });
  const snowdrop = createSnowdrop({
    storage,
    fetch: daemon.fetch,
    repository: new MemoryMessageRepository(),
  });
  await act(async () => {
    await snowdrop.start();
    await flush();
  });
  return snowdrop;
}

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('ConversationIntro: no-history note', () => {
  it('shows the note for signal-cli', async () => {
    snowdrop = await bootSignalCliSnowdrop();
    const id = directConversationId('alice');
    snowdrop.stores.conversations.getState().upsert({
      id,
      kind: 'direct',
      title: 'Alice',
      memberIds: [SELF_ACI, 'alice'],
      adminIds: [],
      expireTimerSec: 0,
      lastActivityAt: 0,
    });
    render(
      <SnowdropProvider snowdrop={snowdrop}>
        <ConversationIntro conversationId={id} />
      </SnowdropProvider>,
    );
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it('never shows the note for the demo backend', async () => {
    snowdrop = await bootSnowdrop();
    const [conv] = Object.values(snowdrop.stores.conversations.getState().byId);
    expect(conv).toBeTruthy();
    render(
      <SnowdropProvider snowdrop={snowdrop}>
        <ConversationIntro conversationId={conv!.id} />
      </SnowdropProvider>,
    );
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
