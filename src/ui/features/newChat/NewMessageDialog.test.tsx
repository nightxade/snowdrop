import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import type { RecipientLookup } from '@/core/backend';
import {
  colorForId,
  directConversationId,
  messageId,
  type Contact,
  type Message,
} from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import { bootDemo, disposeAll, key, settle, setViewport } from '@/test/bootDemo';
import { failureMessage } from './NewMessageDialog';

beforeEach(() => {
  setViewport(1440);
});

afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  await disposeAll();
});

const composer = () => document.querySelector<HTMLElement>('[data-snowdrop="composer"] textarea');
const selected = (s: Snowdrop) => uiSelectors.selectedConversation(s.stores.ui.getState());

async function openDialog(): Promise<{
  snowdrop: Snowdrop;
  mock: MockBackend;
  input: HTMLElement;
}> {
  const snowdrop = await bootDemo();
  const mock = (await snowdrop.backendReady) as MockBackend;
  key({ key: 'n', code: 'KeyN', ctrlKey: true });
  const input = await screen.findByRole('combobox', { name: 'Name, username or number' });
  return { snowdrop, mock, input };
}

const type = (input: HTMLElement, value: string) => {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
};

/** Never-resolving lookups would leave the app waiting; tests release them. */
function deferredLookup(mock: MockBackend) {
  let release: (r: RecipientLookup) => void = () => undefined;
  const spy = vi.spyOn(mock, 'lookupRecipient').mockImplementation(
    () =>
      new Promise<RecipientLookup>((resolve) => {
        release = resolve;
      }),
  );
  return {
    spy,
    release: (r: RecipientLookup) => {
      release(r);
    },
  };
}

describe('New message: entry points', () => {
  it('opens from Ctrl+N (Signal Desktop’s shortcut), with focus in the search field', async () => {
    const { input } = await openDialog();
    expect(screen.getByRole('dialog', { name: 'New message' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('placeholder')).toBe('Name, username, or number');
  });

  it('opens from the Home sidebar button and from the command palette', async () => {
    const snowdrop = await bootDemo();
    const button = within(
      document.querySelector<HTMLElement>('[data-snowdrop="sidebar-header"]')!,
    ).getByRole('button', { name: 'New message' });
    act(() => {
      fireEvent.click(button);
    });
    expect(await screen.findByRole('dialog', { name: 'New message' })).toBeTruthy();
    key({ key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();

    key({ key: 'k', code: 'KeyK', ctrlKey: true });
    const palette = await screen.findByRole('combobox', { name: 'Quick switcher' });
    type(palette, '>new message');
    const option = await screen.findByRole('option', { name: /New message/u });
    act(() => {
      fireEvent.click(option);
    });
    expect(await screen.findByRole('dialog', { name: 'New message' })).toBeTruthy();
    expect(snowdrop.stores.ui.getState().modal?.type).toBe('newMessage');
  });
});

describe('New message: contacts', () => {
  it('filters contacts as you type and opens the existing DM, focusing the composer', async () => {
    const { snowdrop, input } = await openDialog();
    const dm = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.kind === 'direct' && c.lastActivityAt > 0,
    )!;
    const peer =
      snowdrop.stores.contacts.getState().byId[
        dm.memberIds.find((id) => id !== snowdrop.stores.session.getState().self?.id)!
      ]!;
    const before = Object.keys(snowdrop.stores.conversations.getState().byId).length;
    type(input, peer.name);
    const option = screen.getAllByRole('option')[0]!;
    expect(option.textContent).toContain(peer.name);
    key({ key: 'Enter' }, input);
    await settle();
    expect(selected(snowdrop)).toBe(dm.id);
    expect(Object.keys(snowdrop.stores.conversations.getState().byId)).toHaveLength(before);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(composer());
  });

  it('opens a contact with no DM yet as an empty local conversation, sending nothing', async () => {
    const { snowdrop, mock, input } = await openDialog();
    const fresh: Contact = { id: 'fresh-aci', name: 'Quinn Fresh', color: colorForId('fresh-aci') };
    act(() => {
      snowdrop.stores.contacts.getState().upsert(fresh);
    });
    const spies = [
      vi.spyOn(mock, 'send'),
      vi.spyOn(mock, 'markRead'),
      vi.spyOn(mock, 'setTyping'),
      vi.spyOn(mock, 'respondToMessageRequest'),
    ];
    type(input, 'quinn');
    key({ key: 'Enter' }, document.activeElement ?? input);
    await settle();
    const id = directConversationId('fresh-aci');
    expect(selected(snowdrop)).toBe(id);
    expect(snowdrop.stores.conversations.getState().byId[id]).toMatchObject({
      kind: 'direct',
      title: 'Quinn Fresh',
      lastActivityAt: 0,
    });
    expect(document.activeElement).toBe(composer());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('says so when nothing matches', async () => {
    const { input } = await openDialog();
    type(input, 'zzzzqq');
    expect(await screen.findByText('No contacts match “zzzzqq”.')).toBeTruthy();
    expect(screen.queryByRole('option')).toBeNull();
  });
});

describe('New message: find by phone number or username', () => {
  it('offers Find by phone number for a number, looks it up with a loading state, then opens a new DM', async () => {
    const { snowdrop, mock, input } = await openDialog();
    const { spy, release } = deferredLookup(mock);
    const sends = vi.spyOn(mock, 'send');
    type(input, '+1 (202) 555-0190');
    const option = screen.getByRole('option', { name: /\+1 202 555 0190/u });
    expect(screen.getByText('Find by phone number')).toBeTruthy();
    expect(screen.queryByText('Contacts')).toBeNull();
    key({ key: 'Enter' }, input);
    await settle();
    expect(spy).toHaveBeenCalledWith({ kind: 'phone', e164: '+12025550190' });
    // Loading: announced, the row can't be chosen twice, and the dialog stays open.
    expect(screen.getByText('Looking up +1 202 555 0190…')).toBeTruthy();
    expect(option.getAttribute('aria-disabled')).toBe('true');
    key({ key: 'Enter' }, input);
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ status: 'found', id: 'carol-aci', number: '+12025550190' });
      await Promise.resolve();
    });
    await settle();
    const id = directConversationId('carol-aci');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(selected(snowdrop)).toBe(id);
    expect(snowdrop.stores.conversations.getState().byId[id]).toMatchObject({
      kind: 'direct',
      title: '+1 202 555 0190',
      lastActivityAt: 0,
    });
    expect(snowdrop.stores.contacts.getState().byId['carol-aci']).toMatchObject({
      number: '+12025550190',
    });
    expect(document.activeElement).toBe(composer());
    // Opening sent nothing: no message, so no profile key share either.
    expect(sends).not.toHaveBeenCalled();
  });

  it('finds a username, with or without @', async () => {
    const { snowdrop, mock, input } = await openDialog();
    const spy = vi
      .spyOn(mock, 'lookupRecipient')
      .mockResolvedValue({ status: 'found', id: 'dana-aci', username: 'dana.07' });
    type(input, '@dana.07');
    expect(screen.getByText('Find by username')).toBeTruthy();
    expect(screen.getByRole('option', { name: '@dana.07' })).toBeTruthy();
    key({ key: 'Enter' }, input);
    await settle();
    expect(spy).toHaveBeenCalledWith({ kind: 'username', username: 'dana.07' });
    expect(selected(snowdrop)).toBe(directConversationId('dana-aci'));
    expect(
      snowdrop.stores.conversations.getState().byId[directConversationId('dana-aci')]?.title,
    ).toBe('@dana.07');
  });

  it('opens the existing conversation when the lookup finds someone who already has one', async () => {
    const { snowdrop, mock, input } = await openDialog();
    const dm = Object.values(snowdrop.stores.conversations.getState().byId).find(
      (c) => c.kind === 'direct' && c.lastActivityAt > 0,
    )!;
    const peerId = dm.memberIds.find((id) => id !== snowdrop.stores.session.getState().self?.id)!;
    vi.spyOn(mock, 'lookupRecipient').mockResolvedValue({ status: 'found', id: peerId });
    const before = Object.keys(snowdrop.stores.conversations.getState().byId).length;
    type(input, 'zed.42');
    key({ key: 'Enter' }, input);
    await settle();
    expect(selected(snowdrop)).toBe(dm.id);
    expect(Object.keys(snowdrop.stores.conversations.getState().byId)).toHaveLength(before);
  });

  it('does not offer a lookup for a number that is already a contact', async () => {
    const { snowdrop, input } = await openDialog();
    const contact = Object.values(snowdrop.stores.contacts.getState().byId).find(
      (c) => c.number && !c.isSelf,
    )!;
    type(input, contact.number!);
    expect(screen.queryByText('Find by phone number')).toBeNull();
    expect(screen.getAllByRole('option')[0]?.textContent).toContain(contact.name);
  });

  it('says when the person is not on Signal, in Desktop’s words, and stays open for another try', async () => {
    const { snowdrop, mock, input } = await openDialog();
    vi.spyOn(mock, 'lookupRecipient').mockResolvedValue({ status: 'not-registered' });
    type(input, '+44 20 7123 4567');
    key({ key: 'Enter' }, input);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(
      'User not found. “+442071234567” is not a Signal user.',
    );
    expect(screen.getByRole('dialog', { name: 'New message' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(selected(snowdrop)).not.toBe(directConversationId('x'));
    // Editing the text clears the message.
    type(input, '+44 20 7123 456');
    expect(screen.getByRole('alert').textContent).toBe('');

    type(input, 'ghost.99');
    key({ key: 'Enter' }, input);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(
      '@ghost.99 is not a Signal user. Make sure you’ve entered the complete username.',
    );
  });

  it('says when the lookup is rate limited, and when it fails', async () => {
    const { mock, input } = await openDialog();
    const spy = vi.spyOn(mock, 'lookupRecipient').mockResolvedValue({ status: 'rate-limited' });
    type(input, '+12025550190');
    key({ key: 'Enter' }, input);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(
      'Too many lookups in a short time. Wait a little while, then try again.',
    );
    expect(screen.getByRole('option', { name: /\+1 202 555 0190/u })).toBeTruthy();

    spy.mockRejectedValue(new Error('offline'));
    key({ key: 'Enter' }, input);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(
      'Failed to fetch phone number. Check your connection and try again.',
    );
    expect(screen.getByRole('dialog', { name: 'New message' })).toBeTruthy();
  });

  it('ignores a lookup result that arrives after the text changed or the dialog closed', async () => {
    const { snowdrop, mock, input } = await openDialog();
    const { release } = deferredLookup(mock);
    type(input, '+12025550190');
    key({ key: 'Enter' }, input);
    await settle();
    type(input, 'ben');
    await act(async () => {
      release({ status: 'found', id: 'late-aci' });
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByRole('dialog', { name: 'New message' })).toBeTruthy();
    expect(selected(snowdrop)).not.toBe(directConversationId('late-aci'));
    expect(
      snowdrop.stores.conversations.getState().byId[directConversationId('late-aci')],
    ).toBeUndefined();
  });

  it('explains a number that needs a country code', async () => {
    const { input } = await openDialog();
    type(input, '07911 123456');
    expect(
      await screen.findByText(
        'To look up a number, include its country code, like +1 202 555 0123.',
      ),
    ).toBeTruthy();
  });

  it('does not fork the conversation when the first message arrives afterwards', async () => {
    const { snowdrop, mock, input } = await openDialog();
    vi.spyOn(mock, 'lookupRecipient').mockResolvedValue({
      status: 'found',
      id: 'erin-aci',
      number: '+12025550191',
    });
    type(input, '+12025550191');
    key({ key: 'Enter' }, input);
    await settle();
    const id = directConversationId('erin-aci');
    expect(selected(snowdrop)).toBe(id);
    const message: Message = {
      id: messageId('erin-aci', Date.now()),
      conversationId: id,
      authorId: 'erin-aci',
      sentAt: Date.now(),
      receivedAt: Date.now(),
      body: 'hi, it is Erin',
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'sent',
      kind: 'normal',
    };
    await act(async () => {
      mock.world.conversations.set(id, {
        id,
        kind: 'direct',
        title: 'Erin',
        memberIds: [snowdrop.stores.session.getState().self!.id, 'erin-aci'],
        adminIds: [],
        expireTimerSec: 0,
        lastActivityAt: message.sentAt,
      });
      mock.world.histories.set(id, []);
      mock.deliver(message);
      await Promise.resolve();
    });
    await settle();
    const directs = Object.values(snowdrop.stores.conversations.getState().byId).filter((c) =>
      c.memberIds.includes('erin-aci'),
    );
    expect(directs.map((c) => c.id)).toEqual([id]);
    expect(selected(snowdrop)).toBe(id);
    expect(snowdrop.stores.conversations.getState().lastMessage[id]?.body).toBe('hi, it is Erin');
  });
});

describe('New message: keyboard and accessibility', () => {
  it('is driven by the keyboard: arrows move, Enter opens, Escape closes and returns focus', async () => {
    const snowdrop = await bootDemo();
    const opener = document.querySelector<HTMLElement>('[data-snowdrop="sidebar-header"] button')!;
    opener.focus();
    key({ key: 'n', code: 'KeyN', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Name, username or number' });
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(2);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    key({ key: 'ArrowDown' }, input);
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    key({ key: 'ArrowUp' }, input);
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
    key({ key: 'Escape' }, input);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(snowdrop.stores.ui.getState().modal).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('traps focus inside the dialog', async () => {
    const { input } = await openDialog();
    const dialog = screen.getByRole('dialog', { name: 'New message' });
    key({ key: 'Tab' }, input);
    await settle();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const close = within(dialog).getByRole('button', { name: 'Close' });
    close.focus();
    key({ key: 'Tab', shiftKey: true }, close);
    await settle();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('labels the field, the list and the dialog, and has no axe violations in any state', async () => {
    const { mock, input } = await openDialog();
    const dialog = screen.getByRole('dialog', { name: 'New message' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'People' })).toBeTruthy();
    const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };
    const violations = async () => (await axe(dialog, { rules })).violations.map((v) => v.id);
    expect(await violations()).toEqual([]);

    type(input, '+12025550190');
    expect(await violations()).toEqual([]);

    const { release } = deferredLookup(mock);
    key({ key: 'Enter' }, input);
    await settle();
    expect(await violations()).toEqual([]);
    await act(async () => {
      release({ status: 'not-registered' });
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByRole('alert').textContent).not.toBe('');
    expect(await violations()).toEqual([]);

    type(input, 'zzzzqq');
    expect(await violations()).toEqual([]);
  });
});

describe('failureMessage', () => {
  it('uses Signal Desktop’s wording', () => {
    const phone = { kind: 'phone', e164: '+12025550190' } as const;
    const name = { kind: 'username', username: 'a.42' } as const;
    expect(failureMessage('not-registered', phone)).toBe(
      'User not found. “+1 202 555 0190” is not a Signal user.',
    );
    expect(failureMessage('not-registered', name)).toBe(
      '@a.42 is not a Signal user. Make sure you’ve entered the complete username.',
    );
    expect(failureMessage('failed', name)).toBe(
      'Failed to fetch username. Check your connection and try again.',
    );
    expect(failureMessage('rate-limited', phone)).toMatch(/Too many lookups/u);
  });
});
