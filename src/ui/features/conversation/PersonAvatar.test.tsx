import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  avatarKey,
  directConversationId,
  type AvatarRef,
  type Contact,
  type ConversationView,
} from '@/core/domain';
import { conversationIdFor, makeConversation } from '@/core/domain/testing';
import { createStores, DEFAULT_LOCAL_CONVERSATION } from '@/core/stores';
import { FakeIO, installFakeIO } from '@/test/fakeIntersectionObserver';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { ConversationAvatar } from './ConversationAvatar';
import { resetRevealedAvatars } from './avatarHold';
import { PersonAvatar } from './PersonAvatar';

const PHOTO = 'data:image/jpeg;base64,AAAA';
const ME = 'me';

const contact = (id: string, extra: Partial<Contact> = {}): Contact => ({
  id,
  name: id,
  color: 'tomato',
  ...extra,
});

function setup(contacts: Contact[] = [], photo: string | null = PHOTO) {
  const stores = createStores();
  stores.session.getState().setSelf(contact(ME, { isSelf: true }));
  stores.contacts.getState().upsertMany([contact(ME, { isSelf: true }), ...contacts]);
  const known = new Map<string, string | null>();
  const resolve = vi.fn((ref: AvatarRef) => {
    known.set(avatarKey(ref), photo);
    return Promise.resolve(photo);
  });
  const value = {
    stores,
    backend: {
      resolveAvatarUrl: resolve,
      peekAvatarUrl: (ref: AvatarRef) => known.get(avatarKey(ref)),
    },
  } as unknown as AppServices;
  const view = (ui: React.ReactElement) =>
    render(<SnowdropContextProvider value={value}>{ui}</SnowdropContextProvider>);
  return { stores, resolve, view };
}

async function onScreen(): Promise<void> {
  await act(async () => {
    for (const io of FakeIO.instances) io.emit(true);
    await Promise.resolve();
  });
}

const image = (container: HTMLElement) => container.querySelector('img');

beforeEach(installFakeIO);
afterEach(() => {
  cleanup();
  resetRevealedAvatars();
  vi.unstubAllGlobals();
});

describe('<PersonAvatar />', () => {
  const avatar = (id: string | undefined, extra: object = {}) => (
    <PersonAvatar contactId={id} fallback="AB" color="tomato" size={40} {...extra} />
  );

  it('shows initials at once, then swaps in the real picture without changing size', async () => {
    const { view, resolve } = setup([contact('ana', { inContacts: true, hasAvatar: true })]);
    const { container } = view(avatar('ana'));
    const root = container.firstElementChild as HTMLElement;
    expect(screen.getByText('AB')).toBeTruthy();
    expect(image(container)).toBeNull();
    const size = root.style.getPropertyValue('--avatar-size');
    await onScreen();
    expect(image(container)?.getAttribute('src')).toBe(PHOTO);
    expect(resolve).toHaveBeenCalledWith({ kind: 'contact', id: 'ana' });
    expect(root.style.getPropertyValue('--avatar-size')).toBe(size);
    expect(size).toBe('40px');
  });

  it('keeps the initials for someone with no picture, and for no one at all', async () => {
    const { view } = setup([contact('ana', { inContacts: true })], null);
    const { container } = view(
      <>
        {avatar('ana')}
        {avatar(undefined)}
      </>,
    );
    await onScreen();
    expect(screen.getAllByText('AB')).toHaveLength(2);
    expect(image(container)).toBeNull();
  });

  it('keeps the initials when the picture cannot be loaded', async () => {
    const { view } = setup([contact('ana', { inContacts: true })]);
    const { container } = view(avatar('ana'));
    await onScreen();
    const img = image(container);
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    expect(image(container)).toBeNull();
    expect(screen.getByText('AB')).toBeTruthy();
  });

  it('shows your own picture and a saved contact’s, but fetches nothing for a stranger', async () => {
    const { view, resolve } = setup([
      contact('ana', { inContacts: true }),
      contact('bea', { profileSharing: true }),
      contact('zed', { hasAvatar: true }),
    ]);
    const { container } = view(
      <>
        {avatar(ME)}
        {avatar('ana')}
        {avatar('bea')}
        {avatar('zed')}
      </>,
    );
    await onScreen();
    expect(container.querySelectorAll('img')).toHaveLength(3);
    expect(resolve.mock.calls.map(([ref]) => ref.id).sort()).toEqual(['ana', 'bea', ME]);
  });

  describe('a stranger in a message request', () => {
    const request = directConversationId('zed');

    function stranger() {
      const made = setup([contact('zed', { hasAvatar: true })]);
      made.stores.conversations
        .getState()
        .upsert(makeConversation({ id: request, kind: 'direct', memberIds: [ME, 'zed'] }));
      return made;
    }

    it('stays hidden: initials, and no fetch at all', async () => {
      const { view, resolve } = stranger();
      const { container } = view(avatar('zed', { conversationId: request }));
      await onScreen();
      expect(image(container)).toBeNull();
      expect(screen.getByText('AB')).toBeTruthy();
      expect(resolve).not.toHaveBeenCalled();
    });

    it('shows once the conversation is accepted', async () => {
      const { view, stores, resolve } = stranger();
      const { container } = view(avatar('zed', { conversationId: request }));
      await onScreen();
      expect(image(container)).toBeNull();
      act(() => {
        stores.local.getState().markAccepted(request, 1);
      });
      await onScreen();
      expect(image(container)?.getAttribute('src')).toBe(PHOTO);
      expect(resolve).toHaveBeenCalledWith({ kind: 'contact', id: 'zed' });
    });

    it('offers "View photo" on a large avatar and shows it only after the click', async () => {
      const { view, resolve } = stranger();
      const { container } = view(avatar('zed', { conversationId: request, revealable: true }));
      await onScreen();
      const button = screen.getByRole('button', { name: 'View photo' });
      expect(image(container)).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      fireEvent.click(button);
      await onScreen();
      expect(image(container)?.getAttribute('src')).toBe(PHOTO);
      expect(screen.queryByRole('button', { name: 'View photo' })).toBeNull();
      // That one person only: it is remembered for the session, not for everyone.
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it('offers nothing to view when the stranger has no picture, or when not asked to', () => {
      const { view } = setup([contact('zed')]);
      view(avatar('zed', { revealable: true }));
      expect(screen.queryByRole('button', { name: 'View photo' })).toBeNull();
      cleanup();
      const other = setup([contact('zed', { hasAvatar: true })]);
      other.view(avatar('zed'));
      expect(screen.queryByRole('button', { name: 'View photo' })).toBeNull();
    });

    it('does not trigger the row it sits in when revealed', () => {
      const { view } = setup([contact('zed', { hasAvatar: true })]);
      const onClick = vi.fn();
      view(<div onClick={onClick}>{avatar('zed', { revealable: true })}</div>);
      fireEvent.click(screen.getByRole('button', { name: 'View photo' }));
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  it('shows a stranger in a group that has been accepted', async () => {
    const { view, stores, resolve } = setup([
      contact('ana', { inContacts: true }),
      contact('zed', { hasAvatar: true }),
    ]);
    const group = conversationIdFor('club');
    stores.conversations
      .getState()
      .upsert(makeConversation({ id: group, memberIds: [ME, 'ana', 'zed'] }));
    const { container } = view(avatar('zed', { conversationId: group }));
    await onScreen();
    expect(image(container)).not.toBeNull();
    expect(resolve).toHaveBeenCalledWith({ kind: 'contact', id: 'zed' });
  });
});

describe('<ConversationAvatar />', () => {
  const viewOf = (
    id: ConversationView['id'],
    extra: Partial<ConversationView>,
  ): ConversationView => ({
    ...makeConversation({ id, ...extra }),
    ...DEFAULT_LOCAL_CONVERSATION,
  });

  it("shows an accepted group's picture, fetched by its id", async () => {
    const { view, stores, resolve } = setup([contact('ana', { inContacts: true })]);
    const id = conversationIdFor('club');
    const conversation = makeConversation({ id, title: 'Club', memberIds: [ME, 'ana'] });
    stores.conversations.getState().upsert(conversation);
    const { container } = view(<ConversationAvatar conversation={viewOf(id, conversation)} />);
    expect(screen.getByText('C')).toBeTruthy();
    await onScreen();
    expect(image(container)?.getAttribute('src')).toBe(PHOTO);
    expect(resolve).toHaveBeenCalledWith({ kind: 'group', id });
  });

  it('hides the picture of a group that is a message request', async () => {
    const { view, stores, resolve } = setup([contact('zed')]);
    const id = conversationIdFor('spam');
    const conversation = makeConversation({ id, title: 'Spam', memberIds: [ME, 'zed'] });
    stores.conversations.getState().upsert(conversation);
    const { container } = view(<ConversationAvatar conversation={viewOf(id, conversation)} />);
    await onScreen();
    expect(image(container)).toBeNull();
    expect(screen.getByText('S')).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("falls back to the group's own known photo while the stored one loads", () => {
    const { view, stores } = setup([contact('ana', { inContacts: true })]);
    const id = conversationIdFor('club');
    const conversation = makeConversation({
      id,
      title: 'Club',
      memberIds: [ME, 'ana'],
      avatarUrl: 'data:image/png;base64,SET',
    });
    stores.conversations.getState().upsert(conversation);
    const { container } = view(<ConversationAvatar conversation={viewOf(id, conversation)} />);
    expect(image(container)?.getAttribute('src')).toBe('data:image/png;base64,SET');
  });

  it("shows a direct chat as the person's picture, held while the chat is a request", async () => {
    const { view, stores, resolve } = setup([contact('zed', { hasAvatar: true })]);
    const id = directConversationId('zed');
    const conversation = makeConversation({
      id,
      kind: 'direct',
      title: 'zed',
      memberIds: [ME, 'zed'],
    });
    stores.conversations.getState().upsert(conversation);
    const { container } = view(<ConversationAvatar conversation={viewOf(id, conversation)} />);
    await onScreen();
    expect(image(container)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    act(() => {
      stores.local.getState().markAccepted(id, 1);
    });
    await onScreen();
    expect(image(container)).not.toBeNull();
    expect(resolve).toHaveBeenCalledWith({ kind: 'contact', id: 'zed' });
  });
});
