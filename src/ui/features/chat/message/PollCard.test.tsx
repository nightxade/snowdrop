import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { PollContent } from '@/core/domain';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { PollCard, PollVotesDialog, type PollCardMode } from './PollCard';

afterEach(cleanup);

const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };

const poll = (extra: Partial<PollContent> = {}): PollContent => ({
  question: 'Where to eat?',
  options: ['Pizza', 'Ramen', 'Tacos'],
  allowMultiple: true,
  votes: [],
  ...extra,
});

const v = (voterId: string, optionIndexes: number[], voteCount = 1) => ({
  voterId,
  optionIndexes,
  voteCount,
  at: 1,
});

function renderCard(
  p: PollContent,
  options: {
    mode?: PollCardMode;
    onVote?: (indexes: number[]) => Promise<void>;
    onViewVotes?: () => void;
  } = {},
) {
  const onVote = options.onVote ?? vi.fn(() => Promise.resolve());
  const onViewVotes = options.onViewVotes ?? vi.fn();
  const view = render(
    <PollCard
      poll={p}
      mode={options.mode ?? 'vote'}
      selfId="me"
      onVote={onVote}
      onViewVotes={onViewVotes}
    />,
  );
  return { ...view, onVote, onViewVotes };
}

const option = (name: RegExp | string) => screen.getByRole('checkbox', { name });

describe('<PollCard />', () => {
  it('is a group named by the question and described by how many options may be chosen', () => {
    renderCard(poll());
    const group = screen.getByRole('group', { name: 'Where to eat?' });
    expect(group.getAttribute('data-snowdrop')).toBe('poll');
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Poll · Select one or more',
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    cleanup();
    renderCard(poll({ allowMultiple: false }));
    expect(screen.getByText('Poll · Select one')).toBeTruthy();
  });

  it('gives each option a name that carries its votes and share, for screen readers', () => {
    renderCard(poll({ votes: [v('ana', [0]), v('bo', [0, 1]), v('cy', [2])] }));
    expect(option(/^Pizza 2 votes, 67%/u)).toBeTruthy();
    expect(option(/^Ramen 1 vote, 33%/u)).toBeTruthy();
    expect(option(/^Tacos 1 vote, 33%/u)).toBeTruthy();
  });

  it('sizes each bar to its share of the people who voted', () => {
    const { container } = renderCard(
      poll({ votes: [v('ana', [0]), v('bo', [0, 1]), v('cy', [])] }),
    );
    const widths = [...container.querySelectorAll<HTMLElement>('[class*=fill]')].map(
      (el) => el.style.width,
    );
    // Two people chose something: Pizza by both, Ramen by one, Tacos by none.
    expect(widths).toEqual(['100%', '50%', '0%']);
  });

  it('checks the options you chose', () => {
    renderCard(poll({ votes: [v('me', [1, 2]), v('ana', [0])] }));
    expect((option(/^Pizza/u) as HTMLInputElement).checked).toBe(false);
    expect((option(/^Ramen/u) as HTMLInputElement).checked).toBe(true);
    expect((option(/^Tacos/u) as HTMLInputElement).checked).toBe(true);
  });

  it('adds a choice to your answer on a multiple-choice poll, and removes one', async () => {
    const { onVote } = renderCard(poll({ votes: [v('me', [2])] }));
    fireEvent.click(option(/^Pizza/u));
    expect(onVote).toHaveBeenLastCalledWith([0, 2]);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(option(/^Tacos/u));
    expect(onVote).toHaveBeenLastCalledWith([]);
  });

  it('moves your vote on a single-choice poll', () => {
    const { onVote } = renderCard(poll({ allowMultiple: false, votes: [v('me', [0])] }));
    fireEvent.click(option(/^Ramen/u));
    expect(onVote).toHaveBeenLastCalledWith([1]);
  });

  it('is operated from the keyboard with Space', async () => {
    const user = userEvent.setup();
    const { onVote } = renderCard(poll());
    option(/^Ramen/u).focus();
    await user.keyboard(' ');
    expect(onVote).toHaveBeenCalledWith([1]);
  });

  it('ignores a second change while a vote is on its way, without losing focus', async () => {
    let finish!: () => void;
    const onVote = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderCard(poll(), { onVote });
    const pizza = option(/^Pizza/u);
    pizza.focus();
    fireEvent.click(pizza);
    expect(screen.getByRole('group').getAttribute('aria-busy')).toBe('true');
    expect(pizza.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(option(/^Ramen/u));
    expect(onVote).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(pizza);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.getByRole('group').getAttribute('aria-busy')).toBeNull();
    expect(pizza.getAttribute('aria-disabled')).toBeNull();
  });

  it("shows an unsent poll's options without letting anyone answer", () => {
    const { onVote } = renderCard(poll(), { mode: 'pending' });
    const pizza = option(/^Pizza/u);
    expect(pizza.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(pizza);
    expect(onVote).not.toHaveBeenCalled();
  });

  it("only shows the poll when it is not the user's to answer, marking their own choices", () => {
    renderCard(poll({ votes: [v('me', [1])] }), { mode: 'view' });
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText(/You voted/u)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('turns into final results when ended, keeping your choice visible', () => {
    const { container } = renderCard(poll({ ended: true, votes: [v('me', [0]), v('ana', [2])] }));
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText('Poll · Final results')).toBeTruthy();
    expect(container.querySelector('[data-snowdrop=poll]')?.hasAttribute('data-ended')).toBe(true);
    const pizza = screen.getAllByRole('listitem')[0]!;
    expect(within(pizza).getByText(/You voted/u)).toBeTruthy();
    expect(within(screen.getAllByRole('listitem')[2]!).queryByText(/You voted/u)).toBeNull();
  });

  it('says "No votes" until someone has voted, then offers the details', () => {
    const { onViewVotes } = renderCard(poll());
    expect(screen.getByText('No votes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View votes' })).toBeNull();
    cleanup();
    const second = renderCard(poll({ votes: [v('ana', [0])] }));
    fireEvent.click(screen.getByRole('button', { name: 'View votes' }));
    expect(second.onViewVotes).toHaveBeenCalledOnce();
    expect(onViewVotes).not.toHaveBeenCalled();
  });

  it('shows a long question and options in full, wrapped', () => {
    const long = 'x'.repeat(100);
    renderCard(poll({ question: long, options: [long, 'b'] }));
    expect(screen.getAllByText(long)).toHaveLength(2);
  });

  it('has no axe violations to answer, to wait, to view, or when ended', async () => {
    const votes = [v('me', [0]), v('ana', [0, 1])];
    for (const [mode, extra] of [
      ['vote', {}],
      ['pending', {}],
      ['view', {}],
      ['view', { ended: true }],
    ] as const) {
      const { container, unmount } = renderCard(poll({ votes, ...extra }), { mode });
      expect((await axe(container, { rules })).violations.map((x) => x.id)).toEqual([]);
      unmount();
    }
  });
});

function renderDetails(p: PollContent, onEnd?: () => void) {
  const stores = createStores();
  stores.session.getState().setSelf({ id: 'me', name: 'Me', color: 'x', isSelf: true });
  stores.contacts.getState().upsertMany([
    { id: 'ana', name: 'Ana Lima', color: 'x' },
    { id: 'bo', name: 'Bo Chen', color: 'x' },
  ]);
  const onOpenChange = vi.fn();
  render(
    <SnowdropContextProvider value={{ stores, backend: {} } as unknown as AppServices}>
      <PollVotesDialog poll={p} onEnd={onEnd} onOpenChange={onOpenChange} />
    </SnowdropContextProvider>,
  );
  return { onOpenChange };
}

describe('<PollVotesDialog />', () => {
  const voted = poll({ votes: [v('ana', [0]), v('me', [0, 1]), v('bo', [1])] });

  it('lists who chose each option, you by name "You", and marks the leaders', () => {
    renderDetails(voted);
    const dialog = screen.getByRole('dialog', { name: 'Poll details' });
    expect(within(dialog).getByText('Where to eat?')).toBeTruthy();
    const sections = within(dialog).getAllByRole('heading', { level: 3 });
    expect(sections.map((h) => h.textContent)).toEqual([
      expect.stringContaining('Pizza'),
      expect.stringContaining('Ramen'),
      expect.stringContaining('Tacos'),
    ]);
    const lists = within(dialog).getAllByRole('list');
    expect(
      within(lists[0]!)
        .getAllByRole('listitem')
        .map((li) => li.lastElementChild?.textContent),
    ).toEqual(['Ana Lima', 'You']);
    expect(
      within(lists[1]!)
        .getAllByRole('listitem')
        .map((li) => li.lastElementChild?.textContent),
    ).toEqual(['You', 'Bo Chen']);
    // Pizza and Ramen tie for the lead; Tacos has no votes.
    expect(sections[0]?.textContent).toContain('Winning');
    expect(sections[1]?.textContent).toContain('Winning');
    expect(sections[2]?.textContent).not.toContain('Winning');
    expect(within(dialog).getByText('No votes')).toBeTruthy();
    expect(within(dialog).getAllByText('2 votes')).toHaveLength(2);
  });

  it('offers End poll only when the caller can end it and the poll is open', () => {
    const onEnd = vi.fn();
    renderDetails(voted, onEnd);
    fireEvent.click(screen.getByRole('button', { name: 'End poll' }));
    expect(onEnd).toHaveBeenCalledOnce();
    cleanup();
    renderDetails(voted);
    expect(screen.queryByRole('button', { name: 'End poll' })).toBeNull();
    cleanup();
    renderDetails({ ...voted, ended: true }, onEnd);
    expect(screen.queryByRole('button', { name: 'End poll' })).toBeNull();
  });

  it('has no axe violations', async () => {
    renderDetails(voted, vi.fn());
    const dialog = screen.getByRole('dialog');
    expect((await axe(dialog, { rules })).violations.map((x) => x.id)).toEqual([]);
  });
});
