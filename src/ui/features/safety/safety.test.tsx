import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import {
  directConversationId,
  systemMessageId,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { HOME } from '@/core/stores';
import { bootDemo, disposeAll, settle, setViewport } from '@/test/bootDemo';
import { memberMenu, ProfilePopout } from '@/ui/features/members';
import { renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { safetyBlocks } from './safetyNumber';

beforeEach(() => {
  setViewport(1440);
});
afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  await disposeAll();
});

async function boot() {
  const snowdrop = await bootDemo();
  const mock = (await snowdrop.backendReady) as MockBackend;
  const person = (key: string) => mock.world.personIds.get(key)!;
  return { snowdrop, mock, person };
}
const wait = (ms = 30) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
};
const noAxe = async (el: HTMLElement) => {
  const results = await axe(el);
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
};
const openViewer = async (snowdrop: Snowdrop, contactId: string) => {
  act(() => {
    snowdrop.stores.ui.getState().openModal({ type: 'safetyNumber', props: { contactId } });
  });
  return await screen.findByRole('dialog', { name: 'Verify Safety Number' });
};
const chatHeader = async () =>
  await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-snowdrop="chat-header"]');
    if (!el) throw new Error('no header yet');
    return el;
  });
const lines = (snowdrop: Snowdrop, id: ConversationId) =>
  Object.values(snowdrop.stores.messages.getState().windows[id]?.byId ?? {}).filter(
    (m) => m.kind === 'system',
  );

describe('safety number grouping', () => {
  it('splits 60 digits into 12 groups of 5, whatever the spacing', () => {
    const digits = '1234567890'.repeat(6);
    const blocks = safetyBlocks(digits);
    expect(blocks).toHaveLength(12);
    expect(blocks[0]).toBe('12345');
    expect(blocks[1]).toBe('67890');
    expect(safetyBlocks(blocks.join(' '))).toEqual(blocks);
    expect(safetyBlocks(blocks.join('\n'))).toEqual(blocks);
  });
});

describe('the safety number viewer', () => {
  it('shows the QR code and the number in groups, and has no axe violations', async () => {
    const { snowdrop, mock, person } = await boot();
    const ines = person('ines');
    const expected = (await mock.getSafetyNumber(ines))!;
    const dialog = await openViewer(snowdrop, ines);
    const group = await within(dialog).findByRole('group', { name: /^Safety number with / });
    expect(group.textContent).toBe(safetyBlocks(expected.digits).join(''));
    expect(group.querySelectorAll('span')).toHaveLength(12);
    expect(
      within(dialog).getByRole('img', { name: /QR code of your safety number/u }),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Mark as verified' })).toBeTruthy();
    expect(within(dialog).getByText(/compare the numbers above with their device/u)).toBeTruthy();
    await noAxe(dialog);
  });

  it('marks as verified with the number shown, then clears it, each with its timeline line', async () => {
    const { snowdrop, mock, person } = await boot();
    const ines = person('ines');
    const dm = directConversationId(ines);
    const verify = vi.spyOn(mock, 'verifyIdentity');
    const approve = vi.spyOn(mock, 'approveIdentity');
    const shown = (await mock.getSafetyNumber(ines))!.digits;
    act(() => {
      snowdrop.stores.ui.getState().selectConversation(dm, HOME);
    });
    await settle();
    const dialog = await openViewer(snowdrop, ines);
    await click(await within(dialog).findByRole('button', { name: 'Mark as verified' }));
    await waitFor(() => {
      expect(verify).toHaveBeenCalledWith(ines, shown);
    });
    const clear = await within(dialog).findByRole('button', { name: 'Clear verification' });
    expect(snowdrop.stores.identities.getState().trustById[ines]).toBe('verified');
    await click(clear);
    await waitFor(() => {
      expect(approve).toHaveBeenCalledWith(ines);
    });
    await wait();
    expect(snowdrop.stores.identities.getState().trustById[ines]).toBe('default');
    expect(within(dialog).getByRole('button', { name: 'Mark as verified' })).toBeTruthy();
    const name = snowdrop.stores.contacts.getState().byId[ines]!.name;
    const texts = lines(snowdrop, dm).map((m) => m.systemText);
    expect(texts).toContain(`You marked your Safety Number with ${name} as verified`);
    expect(texts).toContain(`You marked your Safety Number with ${name} as not verified`);
  });

  it('says so when the number changed right after it was opened, and shows the new one', async () => {
    const { snowdrop, mock, person } = await boot();
    const ines = person('ines');
    const before = (await mock.getSafetyNumber(ines))!.digits;
    const dialog = await openViewer(snowdrop, ines);
    const button = await within(dialog).findByRole('button', { name: 'Mark as verified' });
    mock.changeIdentity(ines);
    await click(button);
    const alert = await within(dialog).findByRole('alert');
    await waitFor(() => {
      expect(alert.textContent).toMatch(/The safety number you are trying to verify has changed/u);
    });
    const group = within(dialog).getByRole('group', { name: /^Safety number with / });
    expect(group.textContent).not.toBe(safetyBlocks(before).join(''));
    expect(within(dialog).getByText(/isn’t approved yet/u)).toBeTruthy();
    expect(snowdrop.stores.identities.getState().trustById[ines]).toBe('untrusted');
  });

  it('says there is nothing to verify before any messages', async () => {
    const { snowdrop, mock, person } = await boot();
    vi.spyOn(mock, 'getSafetyNumber').mockResolvedValue(null);
    const dialog = await openViewer(snowdrop, person('ines'));
    expect(
      await within(dialog).findByText(
        'This user can’t be verified until you’ve exchanged messages with them.',
      ),
    ).toBeTruthy();
    await click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports a failed read and a failed verification without a number in the message', async () => {
    const { snowdrop, mock, person } = await boot();
    const ines = person('ines');
    const read = vi.spyOn(mock, 'getSafetyNumber').mockRejectedValueOnce(new Error('offline'));
    const dialog = await openViewer(snowdrop, ines);
    expect(await within(dialog).findByText(/Couldn’t read the safety number/u)).toBeTruthy();
    expect(read).toHaveBeenCalled();
  });
});

describe('the verified badge and the menus', () => {
  it('shows Verified in the DM header once verified, and View safety number in the details', async () => {
    const { snowdrop, mock, person } = await boot();
    const ines = person('ines');
    const dm = directConversationId(ines);
    await mock.verifyIdentity(ines, (await mock.getSafetyNumber(ines))!.digits);
    act(() => {
      snowdrop.stores.ui.getState().selectConversation(dm, HOME);
    });
    const header = await chatHeader();
    await waitFor(() => {
      expect(within(header).getByRole('img', { name: 'Verified' })).toBeTruthy();
    });
    await click(within(header).getByRole('button', { name: 'Ines Okafor' }));
    const details = await screen.findByRole('button', { name: 'View safety number' });
    await click(details);
    await wait(60);
    expect(await screen.findByRole('dialog', { name: 'Verify Safety Number' })).toBeTruthy();
  });

  it('no badge for someone who is not verified', async () => {
    const { snowdrop, person } = await boot();
    act(() => {
      snowdrop.stores.ui.getState().selectConversation(directConversationId(person('lucia')), HOME);
    });
    const header = await chatHeader();
    await wait(60);
    expect(within(header).queryByRole('img', { name: 'Verified' })).toBeNull();
  });
});

describe('the member menu and profile', () => {
  it('both offer View safety number for someone else, never for yourself', async () => {
    const { snowdrop, person } = await boot();
    const ines = snowdrop.stores.contacts.getState().byId[person('ines')]!;
    const self = snowdrop.stores.session.getState().self!;
    const group = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.kind === 'group',
    )!.id;
    const ids = (c: typeof ines) =>
      memberMenu(snowdrop, c, group, () => undefined).map((e) => e.id);
    expect(ids(ines)).toContain('safety-number');
    expect(ids(self)).not.toContain('safety-number');
    renderWithSnowdrop(snowdrop, <ProfilePopout contact={ines} onClose={() => undefined} />);
    await click(screen.getByRole('button', { name: 'View safety number' }));
    await wait(60);
    expect(snowdrop.stores.ui.getState().modal).toMatchObject({
      type: 'safetyNumber',
      props: { contactId: ines.id },
    });
  });
});

describe('a changed safety number', () => {
  it('the demo person’s key starts untrusted, and the viewer says so', async () => {
    const { snowdrop, mock, person } = await boot();
    const annika = person('annika');
    const dialog = await openViewer(snowdrop, annika);
    expect(await within(dialog).findByText(/isn’t approved yet/u)).toBeTruthy();
    expect(within(dialog).getByText('Not approved yet')).toBeTruthy();
    expect(snowdrop.stores.identities.getState().trustById[annika]).toBe('untrusted');
    expect((await mock.getSafetyNumber(annika))?.trust).toBe('untrusted');
  });

  it('adds one line for a burst of held-back messages, a new one after a real message', async () => {
    const { snowdrop, mock, person } = await boot();
    const ines = person('ines');
    const dm = directConversationId(ines);
    act(() => {
      snowdrop.stores.ui.getState().selectConversation(dm, HOME);
    });
    await settle();
    const line = (sentAt: number): Message => ({
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
      systemText: 'Safety Number with Ines has changed',
      systemAction: { kind: 'safety-number', contactId: ines },
    });
    const base = Date.now();
    const deliver = (m: Message) => {
      (mock as unknown as { deliver(m: Message): void }).deliver(m);
    };
    await act(async () => {
      deliver(line(base));
      deliver(line(base + 1));
      await snowdrop.sync.idle();
    });
    const count = () =>
      lines(snowdrop, dm).filter((m) => m.systemAction?.kind === 'safety-number').length;
    expect(count()).toBe(1);
    await act(async () => {
      const { systemAction: _action, systemText: _text, ...bare } = line(base + 2);
      deliver({
        ...bare,
        id: `${ines}:${base + 2}` as Message['id'],
        kind: 'normal',
        body: 'hello again',
      });
      deliver(line(base + 3));
      await snowdrop.sync.idle();
    });
    expect(count()).toBe(2);
  });
});

describe('a send blocked by a changed safety number', () => {
  async function blockedSend() {
    const ctx = await boot();
    const annika = ctx.person('annika');
    const dm = directConversationId(annika);
    act(() => {
      ctx.snowdrop.stores.ui.getState().selectConversation(dm, HOME);
    });
    await settle();
    const nonce = await act(() =>
      ctx.snowdrop.send.send({
        conversationId: dm,
        text: 'see you soon',
        mentionIds: [],
        attachments: [],
      }),
    );
    await wait(60);
    return { ...ctx, annika, dm, nonce: nonce! };
  }
  const failedRow = (s: Snowdrop, dm: ConversationId, nonce: string) =>
    s.stores.messages.getState().findByNonce(dm, nonce);

  it('opens the review dialog and keeps the message failed, with a way back to it', async () => {
    const { snowdrop, annika, dm, nonce } = await blockedSend();
    const dialog = await screen.findByRole('dialog', { name: 'Safety Number Changes' });
    expect(failedRow(snowdrop, dm, nonce)).toMatchObject({
      status: 'failed',
      blockedByIdentity: [annika],
    });
    expect(
      within(dialog).getByText(/may have reinstalled Signal or changed devices/u),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /^View safety number with / })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Send anyway' })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Cancel');
    await noAxe(dialog);
    await click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(failedRow(snowdrop, dm, nonce)?.status).toBe('failed');
  });

  it('Send anyway accepts the new key and sends the same message', async () => {
    const { snowdrop, mock, annika, dm, nonce } = await blockedSend();
    const approve = vi.spyOn(mock, 'approveIdentity');
    const send = vi.spyOn(mock, 'send');
    const dialog = await screen.findByRole('dialog', { name: 'Safety Number Changes' });
    await click(within(dialog).getByRole('button', { name: 'Send anyway' }));
    await waitFor(() => {
      expect(approve).toHaveBeenCalledWith(annika);
    });
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    await wait(60);
    const sent = failedRow(snowdrop, dm, nonce);
    expect(sent?.status).not.toBe('failed');
    expect(sent?.blockedByIdentity).toBeUndefined();
    expect(sent?.body).toBe('see you soon');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(snowdrop.stores.identities.getState().trustById[annika]).toBe('default');
  });

  it('a person verified during the review is left verified, and the button says Send', async () => {
    const { snowdrop, mock, annika, dm, nonce } = await blockedSend();
    const approve = vi.spyOn(mock, 'approveIdentity');
    const dialog = await screen.findByRole('dialog', { name: 'Safety Number Changes' });
    await click(within(dialog).getByRole('button', { name: /^View safety number with / }));
    const viewer = await screen.findByRole('dialog', { name: 'Verify Safety Number' });
    await click(await within(viewer).findByRole('button', { name: 'Mark as verified' }));
    await wait(60);
    await click(within(viewer).getByRole('button', { name: 'Back' }));
    const back = await screen.findByRole('dialog', { name: 'Safety Number Changes' });
    expect(within(back).getByText('Verified', { exact: false })).toBeTruthy();
    await click(within(back).getByRole('button', { name: 'Send' }));
    await wait(60);
    expect(approve).not.toHaveBeenCalled();
    expect(failedRow(snowdrop, dm, nonce)?.status).not.toBe('failed');
    expect(snowdrop.stores.identities.getState().trustById[annika]).toBe('verified');
  });

  it('stays open with a message when the key can’t be accepted, and sends nothing', async () => {
    const { mock } = await blockedSend();
    vi.spyOn(mock, 'approveIdentity').mockRejectedValue(new Error('offline'));
    const send = vi.spyOn(mock, 'send');
    const dialog = await screen.findByRole('dialog', { name: 'Safety Number Changes' });
    await click(within(dialog).getByRole('button', { name: 'Send anyway' }));
    await wait(60);
    expect(await within(dialog).findByText(/Couldn’t accept the new safety number/u)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Safety Number Changes' })).toBeTruthy();
  });
});
