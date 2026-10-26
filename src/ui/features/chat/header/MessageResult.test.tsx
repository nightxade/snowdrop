import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMessage } from '@/core/domain/testing';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { MessageResult } from './MessageResult';

afterEach(cleanup);

function renderResult(message = makeMessage({ authorId: 'ana', body: 'hello' })) {
  const stores = createStores();
  stores.contacts.getState().upsert({ id: 'ana', name: 'Ana Lima', color: 'x' });
  render(
    <SnowdropContextProvider value={{ stores } as unknown as AppServices}>
      <MessageResult message={message} onOpen={vi.fn()} />
    </SnowdropContextProvider>,
  );
}

describe('<MessageResult />', () => {
  it("shows a message's text", () => {
    renderResult();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('shows a poll, which has no text, as its question', () => {
    renderResult(
      makeMessage({
        authorId: 'ana',
        body: '',
        poll: { question: 'Where to eat?', options: ['a', 'b'], allowMultiple: true, votes: [] },
      }),
    );
    expect(screen.getByText('📊 Poll: Where to eat?')).toBeTruthy();
  });
});
