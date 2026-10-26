import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { Emitter } from '@/core/lib';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { LiveAnnouncer } from './LiveAnnouncer';

const conv = conversationIdFor('g');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const stores = createStores();
  stores.session.getState().setSelf({ id: 'me', name: 'Me', color: 'x', isSelf: true });
  stores.contacts.getState().upsert({ id: 'ana', name: 'Ana Lima', color: 'x' });
  const sync = new Emitter<{ message: Message }>();
  render(
    <SnowdropContextProvider value={{ stores, sync } as unknown as AppServices}>
      <LiveAnnouncer conversationId={conv} />
    </SnowdropContextProvider>,
  );
  return (partial: Partial<Message>) => {
    act(() => {
      sync.emit('message', makeMessage({ conversationId: conv, authorId: 'ana', ...partial }));
      vi.advanceTimersByTime(2000);
    });
  };
}

describe('<LiveAnnouncer />', () => {
  it("announces a message's text", () => {
    const receive = setup();
    receive({ body: 'dinner at 8' });
    expect(screen.getByRole('status').textContent).toBe('Ana Lima: dinner at 8');
  });

  it('announces a new poll by its question', () => {
    const receive = setup();
    receive({
      body: '',
      poll: { question: 'Where to eat?', options: ['a', 'b'], allowMultiple: false, votes: [] },
    });
    expect(screen.getByRole('status').textContent).toBe('Ana Lima: Poll: Where to eat?');
  });

  it('says only that something was sent when there is nothing to read', () => {
    const receive = setup();
    receive({ body: '' });
    expect(screen.getByRole('status').textContent).toBe('Ana Lima: sent a message');
  });
});
