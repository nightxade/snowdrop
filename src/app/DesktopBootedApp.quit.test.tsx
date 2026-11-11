/**
 * Quitting with a send in flight, through the flusher `DesktopBootedApp`
 * registers for the close handshake (the real quit path): the aborted send's
 * "may have sent" outcome must be recorded before the writes are flushed, or
 * the exit can lose it and the next start shows a plain Retry.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALICE, SELF_ACI, SELF_NUMBER } from '@/core/backend/signal-cli/fixtures/envelopes';
import { FakeDaemon, flush } from '@/core/backend/signal-cli/testing';
import { directConversationId } from '@/core/domain';
import { hydrateKeyValue, MemoryMessageRepository, plaintextCipher } from '@/core/persistence';
import type { FetchLike } from '@/core/backend/signal-cli';
import type { Snowdrop, SnowdropOptions } from './createSnowdrop';

const captured = vi.hoisted((): { snowdrop: unknown; fetch: unknown } => ({
  snowdrop: null,
  fetch: null,
}));

vi.mock('./createSnowdrop', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const create = actual.createSnowdrop as (options?: SnowdropOptions) => Snowdrop;
  return {
    ...actual,
    createSnowdrop: (options?: SnowdropOptions) => {
      const snowdrop = create({
        ...options,
        fetch: captured.fetch as FetchLike,
      });
      captured.snowdrop = snowdrop;
      return snowdrop;
    },
  };
});

const { DesktopBootedApp } = await import('./DesktopBootedApp');

afterEach(cleanup);

describe('DesktopBootedApp: quitting mid-send', () => {
  it('records "may have sent" before the exit flush writes the repository', async () => {
    // A real signal-cli adapter whose daemon never answers `send`.
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .reply('listContacts', [])
      .reply('listGroups', [])
      .handle('send', () => new Promise<never>(() => undefined));
    captured.fetch = daemon.fetch;
    const storage = await hydrateKeyValue(plaintextCipher());
    storage.setItem(
      'snowdrop.settings',
      JSON.stringify({
        v: 2,
        data: { connection: { backend: 'signal-cli', daemonUrl: '/signal-cli', account: null } },
      }),
    );
    const repository = new MemoryMessageRepository();
    const registerFlusher = vi.fn();
    render(
      <DesktopBootedApp
        storage={storage}
        repository={repository}
        registerFlusher={registerFlusher}
      />,
    );
    const snowdrop = captured.snowdrop as Snowdrop;
    await snowdrop.start();
    await flush();
    const conversationId = directConversationId(ALICE);
    await snowdrop.history.open(conversationId);
    const sending = snowdrop.send.send({
      conversationId,
      text: 'on my way',
      mentionIds: [],
      attachments: [],
    });
    await flush();
    expect(daemon.callsTo('send')).toHaveLength(1);

    // What the row looks like at the moment the exit flush reaches the repository.
    let atFlush: unknown;
    vi.spyOn(repository, 'flush').mockImplementation(() => {
      const window = snowdrop.stores.messages.getState().windows[conversationId];
      atFlush = Object.values(window?.byId ?? {}).find(
        (m) => m.status === 'failed' || m.status === 'pending',
      );
      return Promise.resolve();
    });
    const [flusher] = registerFlusher.mock.calls[0] as [() => Promise<void>];
    await flusher();
    await sending;

    expect(atFlush).toMatchObject({ status: 'failed', sendUnconfirmed: true });
    expect(await repository.listOutbox()).toHaveLength(1);
  });
});
