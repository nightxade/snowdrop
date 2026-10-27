import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { ConversationArea } from '../ConversationArea';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

async function open(key: 'request-dm' | 'request-group' | 'crux') {
  snowdrop = await bootSnowdrop();
  const mock = (await snowdrop.backendReady) as MockBackend;
  const conversationId = mock.world.conversationIds.get(key)!;
  const controller = new ChatController();
  renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={controller}>
      <ConversationArea conversationId={conversationId} />
    </ChatControllerProvider>,
  );
  await settle(snowdrop);
  return { snowdrop, conversationId, controller };
}

const bar = () => document.querySelector<HTMLElement>('[data-snowdrop="message-request"]');
const composer = () => document.querySelector('[data-snowdrop="composer"]');

describe('MessageRequestBar in the conversation', () => {
  it('stands in for the composer on a direct request, saying who it is', async () => {
    await open('request-dm');
    expect(composer()).toBeNull();
    const region = screen.getByRole('region', { name: 'Message request' });
    expect(region).toBe(bar());
    expect(within(region).getByText('Marlowe Quist')).toBeTruthy();
    expect(within(region).getByText('+1 202 555 0300')).toBeTruthy();
    expect(
      within(region).getByText(/If you accept, they will see your name and photo/u),
    ).toBeTruthy();
    expect(bar()?.getAttribute('data-state')).toBe('request');
    expect(
      within(region)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Block', 'Delete', 'Accept']);
  });

  it('describes a group request by its name and size', async () => {
    await open('request-group');
    const region = screen.getByRole('region', { name: 'Message request' });
    expect(within(region).getByText('Thursday Wheel Club')).toBeTruthy();
    expect(within(region).getByText('Group · 3 members')).toBeTruthy();
    expect(within(region).getByText(/Nobody you know is in this group/u)).toBeTruthy();
  });

  it('shows the ordinary composer, no bar, in a normal chat', async () => {
    await open('crux');
    expect(bar()).toBeNull();
    expect(composer()).not.toBeNull();
  });

  it('Accept answers the request, brings the composer back and moves focus into it', async () => {
    const { snowdrop: app, conversationId } = await open('request-dm');
    const respond = vi.spyOn(app.backend, 'respondToMessageRequest');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await settle(app);
    expect(respond).toHaveBeenCalledWith(conversationId, 'accept');
    expect(bar()).toBeNull();
    const field = document.querySelector('[data-snowdrop="composer"] textarea');
    expect(field).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(document.activeElement).toBe(field);
  });

  it('Delete asks first, then deletes and leaves nothing open', async () => {
    const { snowdrop: app, conversationId } = await open('request-dm');
    const respond = vi.spyOn(app.backend, 'respondToMessageRequest');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this chat?')).toBeTruthy();
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await settle(app);
    expect(respond).toHaveBeenCalledWith(conversationId, 'delete');
    expect(app.stores.conversations.getState().byId[conversationId]).toBeUndefined();
  });

  it('cancelling the confirmation changes nothing', async () => {
    const { snowdrop: app, conversationId } = await open('request-dm');
    const respond = vi.spyOn(app.backend, 'respondToMessageRequest');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await settle(app);
    expect(respond).not.toHaveBeenCalled();
    expect(app.stores.conversations.getState().byId[conversationId]).toBeDefined();
  });

  it('a group says it will leave, and Delete and leave leaves it', async () => {
    const { snowdrop: app, conversationId } = await open('request-group');
    const respond = vi.spyOn(app.backend, 'respondToMessageRequest');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete and leave?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete and leave' }));
    await settle(app);
    expect(respond).toHaveBeenCalledWith(conversationId, 'delete');
  });

  it('Block asks first, then blocks; the chat stays, shown as blocked with Unblock', async () => {
    const { snowdrop: app, conversationId } = await open('request-dm');
    const setBlocked = vi.spyOn(app.backend, 'setBlocked');
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Block Marlowe Quist?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }));
    await settle(app);
    expect(setBlocked).toHaveBeenCalledWith(conversationId, true);
    const region = screen.getByRole('region', { name: 'Blocked conversation' });
    expect(region.getAttribute('data-state')).toBe('blocked');
    expect(
      within(region)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Delete', 'Unblock']);
    expect(
      within(region).getByText(
        "Let Marlowe Quist message you and share your name and photo with them? You won't receive any messages until you unblock them.",
      ),
    ).toBeTruthy();
    // Unblocking asks first, too.
    fireEvent.click(within(region).getByRole('button', { name: 'Unblock' }));
    const unblockDialog = await screen.findByRole('dialog');
    expect(within(unblockDialog).getByText('Unblock Marlowe Quist?')).toBeTruthy();
    expect(setBlocked).toHaveBeenCalledTimes(1);
    fireEvent.click(within(unblockDialog).getByRole('button', { name: 'Unblock' }));
    await settle(app);
    expect(setBlocked).toHaveBeenLastCalledWith(conversationId, false);
    expect(bar()).toBeNull();
    expect(composer()).not.toBeNull();
  });

  it('blocking a group request blocks and leaves it, keeping its history, and says so first', async () => {
    const { snowdrop: app, conversationId } = await open('request-group');
    const setBlocked = vi.spyOn(app.backend, 'setBlocked');
    const leave = vi.spyOn(app.backend, 'leaveGroup');
    const kept = await app.repository.count(conversationId);
    expect(kept).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Block and Leave Thursday Wheel Club?')).toBeTruthy();
    expect(leave).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }));
    await settle(app);
    expect(setBlocked).toHaveBeenCalledWith(conversationId, true);
    expect(leave).toHaveBeenCalledWith(conversationId, []);
    const group = app.stores.conversations.getState().byId[conversationId];
    expect(group).toMatchObject({ blocked: true, left: true });
    expect(await app.repository.count(conversationId)).toBeGreaterThanOrEqual(kept);
    expect(screen.getByRole('region', { name: 'Blocked conversation' })).toBeTruthy();
  });

  it('keeps the request, with a message, when the answer fails; Accept can be tried again', async () => {
    const { snowdrop: app } = await open('request-dm');
    vi.spyOn(app.backend, 'respondToMessageRequest').mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await settle(app);
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Couldn't accept this request",
    );
    expect(bar()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await settle(app);
    expect(bar()).toBeNull();
  });

  it('is reachable by keyboard: every action is a button in tab order, none takes focus by itself', async () => {
    await open('request-dm');
    const buttons = within(bar()!).getAllByRole('button');
    for (const b of buttons) expect(b.tabIndex).toBeGreaterThanOrEqual(0);
    expect(bar()!.contains(document.activeElement)).toBe(false);
    buttons[2]!.focus();
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('has no axe violations, with or without the confirmation open', async () => {
    await open('request-dm');
    const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };
    expect((await axe(bar()!, { rules })).violations.map((v) => v.id)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    const dialog = await screen.findByRole('dialog');
    expect((await axe(dialog, { rules })).violations.map((v) => v.id)).toEqual([]);
  });
});
