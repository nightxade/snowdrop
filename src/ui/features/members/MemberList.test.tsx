import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { MockBackend } from '@/core/backend/mock';
import { colorForId, type Contact, type ConversationId } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { MemberList } from './MemberList';

const snowdrops: Snowdrop[] = [];

afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

const nameOf = (n: number) => `Member ${String(n).padStart(4, '0')}`;

/** A group of `size` members (you included) on the demo backend. */
async function bootGroup(size: number): Promise<{ snowdrop: Snowdrop; id: ConversationId }> {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const mock = (await snowdrop.backendReady) as MockBackend;
  const id = mock.world.conversationIds.get('crux')!;
  const contacts: Contact[] = Array.from({ length: size }, (_, i) => ({
    id: `m-${i}`,
    name: nameOf(i),
    color: colorForId(`m-${i}`),
  }));
  act(() => {
    snowdrop.stores.contacts.getState().upsertMany(contacts);
    const conversation = snowdrop.stores.conversations.getState().byId[id]!;
    snowdrop.stores.conversations.getState().upsert({
      ...conversation,
      memberIds: contacts.map((c) => c.id),
      adminIds: [],
      pendingMemberIds: [],
      requestingMemberIds: [],
    });
  });
  return { snowdrop, id };
}

async function show(snowdrop: Snowdrop, id: ConversationId): Promise<void> {
  renderWithSnowdrop(
    snowdrop,
    <VirtuosoMockContext.Provider value={{ viewportHeight: 400, itemHeight: 42 }}>
      <MemberList conversationId={id} />
    </VirtuosoMockContext.Provider>,
  );
  await settle(snowdrop);
  await waitFor(() => {
    act(() => {
      document.querySelectorAll('[data-virtuoso-scroller]').forEach((el) => {
        el.dispatchEvent(new Event('scroll'));
      });
    });
    expect(document.querySelectorAll('[data-snowdrop="member-row"]').length).toBeGreaterThan(0);
  });
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-snowdrop="member-row"]')];

describe('Member list of a large group', () => {
  it('mounts only the rows near the viewport, with one tab stop, and passes axe', async () => {
    const { snowdrop, id } = await bootGroup(600);
    await show(snowdrop, id);
    expect(rows().length).toBeLessThan(80);
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain(nameOf(0));
    expect(
      (
        await axe(screen.getByRole('list', { name: 'Members' }), {
          rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
        })
      ).violations,
    ).toEqual([]);
  });

  it('arrow keys move between rows, and End focuses the last member, which was not mounted', async () => {
    const { snowdrop, id } = await bootGroup(600);
    await show(snowdrop, id);
    const first = rows()[0]!;
    first.focus();
    act(() => {
      fireEvent.keyDown(first, { key: 'ArrowDown' });
    });
    expect(document.activeElement).toBe(rows()[1]);

    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'End' });
    });
    // The window follows the jump (the mock list has no layout, so scroll it ourselves).
    await act(async () => {
      document.querySelectorAll<HTMLElement>('[data-virtuoso-scroller]').forEach((el) => {
        el.scrollTop = 601 * 42 - 400;
        el.dispatchEvent(new Event('scroll'));
      });
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain(nameOf(599));
    });
  });

  const scrollFar = async () => {
    await act(async () => {
      document.querySelectorAll<HTMLElement>('[data-virtuoso-scroller]').forEach((el) => {
        el.scrollTop = 601 * 42 - 400;
        el.dispatchEvent(new Event('scroll'));
      });
      await new Promise((r) => setTimeout(r, 50));
    });
  };
  const scroller = () => document.querySelector<HTMLElement>('[data-virtuoso-scroller]')!;

  it('has no tab stop of its own, and its height is bounded by its own style', async () => {
    const { snowdrop, id } = await bootGroup(600);
    await show(snowdrop, id);
    expect(scroller().hasAttribute('tabindex')).toBe(false);
    expect(scroller().style.maxHeight).toContain('--snowdrop-vh');
  });

  it('keeps exactly one tab stop, on a mounted row, after the tab stop row scrolls away', async () => {
    const { snowdrop, id } = await bootGroup(600);
    await show(snowdrop, id);
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    await scrollFar();
    await waitFor(() => {
      expect(rows()[0]?.textContent).not.toContain(nameOf(0));
    });
    const stops = rows().filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(document.body.contains(stops[0]!)).toBe(true);
  });

  it('keeps focus on the list when the focused row scrolls out and unmounts', async () => {
    const { snowdrop, id } = await bootGroup(600);
    await show(snowdrop, id);
    const first = rows()[0]!;
    act(() => {
      first.focus();
    });
    expect(document.activeElement).toBe(first);
    await scrollFar();
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });
    expect(document.activeElement).toBe(scroller().parentElement);
  });

  it('keeps a short group as plain sections', async () => {
    const { snowdrop, id } = await bootGroup(12);
    renderWithSnowdrop(snowdrop, <MemberList conversationId={id} />);
    await settle(snowdrop);
    expect(rows()).toHaveLength(12);
    expect(document.querySelector('[data-virtuoso-scroller]')).toBeNull();
  });
});
