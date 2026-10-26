import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import {
  mergeDuplicate,
  type Attachment,
  type ConversationId,
  type LinkPreview,
  type Message,
} from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { uiSelectors } from '@/core/stores';
import { bootDemo, disposeAll, key, settle, setViewport } from '@/test/bootDemo';
import { FakeIO, installFakeIO } from '@/test/fakeIntersectionObserver';
import { ChatController } from '../ChatController';
import { GALLERY_PAGE } from './useGallery';

// A 1x1 PNG: resolves straight away (the attachment carries its own URL).
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeEach(() => {
  setViewport(1440);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanup();
  await disposeAll();
});

const att = (id: string, contentType: string, extra: Partial<Attachment> = {}): Attachment => ({
  id,
  contentType,
  url: PIXEL,
  ...extra,
});
const img = (id: string, fileName?: string): Attachment =>
  att(id, 'image/png', fileName ? { fileName } : {});

const selected = (s: Snowdrop): ConversationId =>
  uiSelectors.selectedConversation(s.stores.ui.getState()) as ConversationId;

/** The demo with a conversation open (it starts on the welcome pane). */
async function boot(): Promise<Snowdrop> {
  const snowdrop = await bootDemo();
  const [first] = Object.keys(snowdrop.stores.conversations.getState().byId);
  act(() => {
    snowdrop.stores.ui.getState().selectConversation(first as ConversationId);
  });
  await settle();
  return snowdrop;
}

let clock = Date.now() - 100_000;

async function seed(
  snowdrop: Snowdrop,
  parts: { attachments?: Attachment[]; previews?: LinkPreview[]; body?: string }[],
): Promise<Message[]> {
  const out: Message[] = [];
  for (const part of parts) {
    const { seq: _seq, ...m } = makeMessage({
      conversationId: selected(snowdrop),
      authorId: 'seed-author',
      sentAt: clock++,
      body: part.body ?? '',
      attachments: part.attachments ?? [],
      ...(part.previews ? { previews: part.previews } : {}),
    });
    out.push((await snowdrop.repository.upsert(m, mergeDuplicate)).message);
  }
  return out;
}

async function openGallery(): Promise<HTMLElement> {
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Media, files & links' }));
  });
  const panel = await screen.findByRole('complementary', { name: 'Media, files and links' });
  await settle();
  return panel;
}

const tab = (panel: HTMLElement, name: string) => within(panel).getByRole('tab', { name });
const tiles = (panel: HTMLElement) => within(panel).queryAllByRole('button', { name: /^Open / });

describe('Media, files & links', () => {
  it('opens from the header with four tabs, Media first, and closes on Esc', async () => {
    const snowdrop = await boot();
    await seed(snowdrop, [{ attachments: [img('p1', 'beach.png')] }]);
    const panel = await openGallery();
    expect(
      within(panel)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Media', 'Audio', 'Links', 'Files']);
    expect(tab(panel, 'Media').getAttribute('aria-selected')).toBe('true');
    expect(tiles(panel).length).toBeGreaterThan(0);
    const toggle = screen.getByRole('button', { name: 'Hide media, files & links' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    key({ key: 'Escape' }, tab(panel, 'Media'));
    await settle();
    expect(screen.queryByRole('complementary', { name: 'Media, files and links' })).toBeNull();
    // Focus is back on the button that opened it.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Media, files & links' }),
    );
  });

  it('also opens from the conversation details popover', async () => {
    await boot();
    act(() => {
      fireEvent.click(
        document.querySelector<HTMLElement>('[data-snowdrop="chat-header"] h1 button')!,
      );
    });
    // The header's own button is a toggle (aria-pressed); the popover's entry is not.
    const entry = (await screen.findAllByRole('button', { name: 'Media, files & links' })).find(
      (b) => !b.hasAttribute('aria-pressed'),
    );
    act(() => {
      fireEvent.click(entry!);
    });
    expect(
      await screen.findByRole('complementary', { name: 'Media, files and links' }),
    ).toBeTruthy();
  });

  it('is exclusive with the search panel', async () => {
    await boot();
    const panel = await openGallery();
    expect(panel).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    });
    await settle();
    expect(screen.queryByRole('complementary', { name: 'Media, files and links' })).toBeNull();
    expect(document.querySelector('[data-snowdrop="search-panel"]')).toBeTruthy();
  });

  it('groups media under date headings, newest first', async () => {
    const snowdrop = await boot();
    const day = 86_400_000;
    const old = Date.now() - 400 * day;
    const { seq: _seq, ...ancient } = makeMessage({
      conversationId: selected(snowdrop),
      authorId: 'seed-author',
      sentAt: old,
      receivedAt: old,
      attachments: [img('ancient', 'ancient.png')],
    });
    await snowdrop.repository.upsert(ancient, mergeDuplicate);
    await seed(snowdrop, [{ attachments: [img('fresh', 'fresh.png')] }]);
    const panel = await openGallery();
    const headings = within(panel)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings[0]).toBe('Today');
    expect(headings.at(-1)).toMatch(/^[A-Z][a-z]+ \d{4}$/u);
  });

  it('lists audio, files and links with what each needs', async () => {
    const snowdrop = await boot();
    await seed(snowdrop, [
      {
        attachments: [att('au', 'audio/mpeg', { fileName: 'song.mp3', size: 2048 })],
      },
      {
        attachments: [att('vn', 'audio/webm', { voiceNote: true })],
      },
      {
        attachments: [
          att('f', 'application/pdf', { fileName: 'report.pdf', size: 3 * 1024 * 1024 }),
        ],
      },
      {
        body: 'look https://example.org/post',
        previews: [{ url: 'https://example.org/post', title: 'A post worth reading' }],
      },
    ]);
    const panel = await openGallery();

    act(() => {
      fireEvent.click(tab(panel, 'Audio'));
    });
    await within(panel).findByText('song.mp3');
    expect(within(panel).getByText('Voice message')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Play song.mp3' })).toBeTruthy();

    act(() => {
      fireEvent.click(tab(panel, 'Files'));
    });
    await within(panel).findByText('report.pdf');
    expect(within(panel).getByText(/3\.0 MB/u)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Download report.pdf' })).toBeTruthy();

    act(() => {
      fireEvent.click(tab(panel, 'Links'));
    });
    await within(panel).findByText('A post worth reading');
    const link = within(panel).getByRole('link', { name: 'https://example.org/post' });
    expect(link.getAttribute('href')).toBe('https://example.org/post');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('plays an audio file only once asked', async () => {
    const snowdrop = await boot();
    await seed(snowdrop, [{ attachments: [att('au', 'audio/mpeg', { fileName: 'song.mp3' })] }]);
    const panel = await openGallery();
    act(() => {
      fireEvent.click(tab(panel, 'Audio'));
    });
    await within(panel).findByText('song.mp3');
    expect(panel.querySelector('audio')).toBeNull();
    act(() => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Play song.mp3' }));
    });
    await waitFor(() => {
      expect(panel.querySelector('audio')).toBeTruthy();
    });
  });

  it('shows a note while the phone history is still importing', async () => {
    const snowdrop = await boot();
    act(() => {
      snowdrop.stores.session
        .getState()
        .setHistoryImport({ status: 'importing', percent: 10, imported: 5, error: null });
    });
    const panel = await openGallery();
    expect(within(panel).getByRole('status').textContent).toMatch(/Still importing/u);
  });

  describe('states', () => {
    it('says what each empty tab is for', async () => {
      const snowdrop = await boot();
      vi.spyOn(snowdrop.repository, 'media').mockResolvedValue([]);
      const panel = await openGallery();
      const expected: [string, string][] = [
        ['Media', 'No media'],
        ['Audio', 'No audio'],
        ['Links', 'No links'],
        ['Files', 'No files'],
      ];
      for (const [name, title] of expected) {
        act(() => {
          fireEvent.click(tab(panel, name));
        });
        expect(await within(panel).findByText(title)).toBeTruthy();
      }
      expect(within(panel).getByText(/will appear here/u)).toBeTruthy();
    });

    it('shows a loading skeleton, marked busy, until the first page arrives', async () => {
      const snowdrop = await boot();
      vi.spyOn(snowdrop.repository, 'media').mockImplementation(() => new Promise(() => undefined));
      const panel = await openGallery();
      const body = within(panel).getByRole('tabpanel');
      expect(body.getAttribute('aria-busy')).toBe('true');
      expect(within(panel).queryByText('No media')).toBeNull();
    });

    it('offers a retry when the history cannot be read', async () => {
      const snowdrop = await boot();
      const media = vi
        .spyOn(snowdrop.repository, 'media')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue([]);
      const panel = await openGallery();
      await within(panel).findByText("Couldn't load this tab");
      act(() => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
      });
      expect(await within(panel).findByText('No media')).toBeTruthy();
      expect(media).toHaveBeenCalledTimes(2);
    });

    it('pages on with Load more, newest first, and then stops offering it', async () => {
      const snowdrop = await boot();
      const total = GALLERY_PAGE + 5;
      // The demo conversation already holds some photos of its own.
      const existing = (
        await snowdrop.repository.media(selected(snowdrop), 'media', { limit: 500 })
      )
        .flatMap((m) => m.attachments)
        .filter((a) => a.contentType.startsWith('image/')).length;
      await seed(
        snowdrop,
        Array.from({ length: total }, (_, i) => ({ attachments: [img(`p${i}`, `n${i}.png`)] })),
      );
      const media = vi.spyOn(snowdrop.repository, 'media');
      const panel = await openGallery();
      expect(tiles(panel)).toHaveLength(GALLERY_PAGE);
      // The newest is first.
      expect(tiles(panel)[0]?.getAttribute('aria-label')).toContain(`n${total - 1}.png`);
      act(() => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Load more' }));
      });
      await waitFor(() => {
        expect(tiles(panel)).toHaveLength(total + existing);
      });
      expect(within(panel).queryByRole('button', { name: 'Load more' })).toBeNull();
      expect(media.mock.calls[1]?.[2].before).toBeTypeOf('number');
    });

    it('abandons its scan when the panel closes', async () => {
      const snowdrop = await boot();
      let signal: AbortSignal | undefined;
      vi.spyOn(snowdrop.repository, 'media').mockImplementation((_c, _k, q) => {
        signal = q.signal;
        return new Promise(() => undefined);
      });
      const panel = await openGallery();
      expect(signal?.aborted).toBe(false);
      key({ key: 'Escape' }, tab(panel, 'Media'));
      await settle();
      expect(signal?.aborted).toBe(true);
    });
  });

  describe('jumping to the message', () => {
    it('goes from a file, a link and a media tile, with focus', async () => {
      const snowdrop = await boot();
      const reveal = vi.spyOn(ChatController.prototype, 'reveal').mockResolvedValue(true);
      const [photo, file, link] = await seed(snowdrop, [
        { attachments: [img('p1', 'beach.png')] },
        { attachments: [att('f', 'application/pdf', { fileName: 'report.pdf' })] },
        { body: 'https://example.org/a', previews: [{ url: 'https://example.org/a', title: 'T' }] },
      ]);
      const panel = await openGallery();

      act(() => {
        fireEvent.click(within(panel).getAllByRole('button', { name: 'Go to message' })[0]!);
      });
      expect(reveal).toHaveBeenLastCalledWith(selected(snowdrop), photo!.id, { focus: true });

      act(() => {
        fireEvent.click(tab(panel, 'Files'));
      });
      await within(panel).findByText('report.pdf');
      act(() => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Go to message' }));
      });
      expect(reveal).toHaveBeenLastCalledWith(selected(snowdrop), file!.id, { focus: true });

      act(() => {
        fireEvent.click(tab(panel, 'Links'));
      });
      await within(panel).findByText('T');
      act(() => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Go to message' }));
      });
      expect(reveal).toHaveBeenLastCalledWith(selected(snowdrop), link!.id, { focus: true });
      // Wide layout: the panel stays beside the chat.
      expect(screen.getByRole('complementary', { name: 'Media, files and links' })).toBeTruthy();
    });

    it("is also in a tile's context menu, reachable from the keyboard", async () => {
      const snowdrop = await boot();
      const reveal = vi.spyOn(ChatController.prototype, 'reveal').mockResolvedValue(true);
      const [photo] = await seed(snowdrop, [{ attachments: [img('p1', 'beach.png')] }]);
      const panel = await openGallery();
      const tile = tiles(panel)[0]!;
      tile.focus();
      key({ key: 'F10', shiftKey: true }, tile);
      const item = await screen.findByRole('menuitem', { name: 'Go to message' });
      act(() => {
        fireEvent.click(item);
      });
      expect(reveal).toHaveBeenCalledWith(selected(snowdrop), photo!.id, { focus: true });
    });

    it('closes the sheet on a narrow screen so the message is in view', async () => {
      setViewport(600);
      const snowdrop = await boot();
      vi.spyOn(ChatController.prototype, 'reveal').mockResolvedValue(true);
      await seed(snowdrop, [{ attachments: [att('f', 'application/pdf', { fileName: 'r.pdf' })] }]);
      const panel = await openGallery();
      act(() => {
        fireEvent.click(tab(panel, 'Files'));
      });
      await within(panel).findByText('r.pdf');
      act(() => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Go to message' }));
      });
      await settle();
      expect(screen.queryByRole('complementary', { name: 'Media, files and links' })).toBeNull();
    });
  });

  describe('viewer', () => {
    it('opens the Lightbox on a tile and steps through the whole gallery with the arrows', async () => {
      const snowdrop = await boot();
      await seed(snowdrop, [
        { attachments: [img('a', 'first.png')] },
        { attachments: [img('b', 'second.png')] },
        { attachments: [img('c', 'third.png'), img('d', 'fourth.png')] },
      ]);
      const panel = await openGallery();
      const all = tiles(panel);
      const count = all.length;
      act(() => {
        fireEvent.click(all[1]!);
      });
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(new RegExp(`2 of ${count}`, 'u'))).toBeTruthy();
      key({ key: 'ArrowRight' }, dialog);
      await waitFor(() => {
        expect(within(dialog).getByText(new RegExp(`3 of ${count}`, 'u'))).toBeTruthy();
      });
      key({ key: 'ArrowLeft' }, dialog);
      key({ key: 'ArrowLeft' }, dialog);
      await waitFor(() => {
        expect(within(dialog).getByText(new RegExp(`1 of ${count}`, 'u'))).toBeTruthy();
      });
      // Esc closes the viewer, not the panel behind it.
      key({ key: 'Escape' }, dialog);
      await settle();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('complementary', { name: 'Media, files and links' })).toBeTruthy();
    });
  });

  describe('keyboard', () => {
    it('has one tab stop in the grid and moves with the arrows, Home and End', async () => {
      const snowdrop = await boot();
      await seed(snowdrop, [
        { attachments: [img('a', 'a.png')] },
        { attachments: [img('b', 'b.png')] },
        { attachments: [img('c', 'c.png')] },
      ]);
      const panel = await openGallery();
      const all = tiles(panel);
      expect(all.filter((t) => t.tabIndex === 0)).toHaveLength(1);
      all[0]!.focus();
      key({ key: 'ArrowRight' }, all[0]);
      expect(document.activeElement).toBe(all[1]);
      expect(all[1]!.tabIndex).toBe(0);
      expect(all[0]!.tabIndex).toBe(-1);
      key({ key: 'End' }, all[1]);
      expect(document.activeElement).toBe(all.at(-1));
      key({ key: 'Home' }, all.at(-1));
      expect(document.activeElement).toBe(all[0]);
      key({ key: 'ArrowLeft' }, all[0]);
      expect(document.activeElement).toBe(all[0]);
    });

    it('moves between tabs with the arrows (one tab stop)', async () => {
      await boot();
      const panel = await openGallery();
      const media = tab(panel, 'Media');
      media.focus();
      key({ key: 'ArrowRight' }, media);
      expect(tab(panel, 'Audio').getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tab(panel, 'Audio'));
      expect(media.tabIndex).toBe(-1);
      key({ key: 'End' }, document.activeElement!);
      expect(tab(panel, 'Files').getAttribute('aria-selected')).toBe('true');
      key({ key: 'ArrowRight' }, document.activeElement!);
      expect(tab(panel, 'Media').getAttribute('aria-selected')).toBe('true');
      const selectedTab = within(panel).getByRole('tabpanel');
      expect(selectedTab.getAttribute('aria-labelledby')).toBe('gallery-tab-media');
    });
  });

  describe('thumbnails and downloads', () => {
    it('only loads tiles that are on screen', async () => {
      installFakeIO();
      const snowdrop = await boot();
      await seed(snowdrop, [{ attachments: [img('a', 'a.png'), img('b', 'b.png')] }]);
      const panel = await openGallery();
      expect(panel.querySelectorAll('img')).toHaveLength(0);
      const observed = FakeIO.instances.filter((io) =>
        [...io.observed].some((el) => el.tagName === 'LI'),
      );
      expect(observed.length).toBeGreaterThanOrEqual(2);
      // Only the first tile scrolls into range.
      act(() => {
        observed[0]?.emit(true);
      });
      expect(panel.querySelectorAll('img')).toHaveLength(1);
      // And scrolling it away again lets go of it.
      act(() => {
        observed[0]?.emit(false);
      });
      expect(panel.querySelectorAll('img')).toHaveLength(0);
    });

    it('does not fetch a file until Download is pressed', async () => {
      const snowdrop = await boot();
      await seed(snowdrop, [{ attachments: [att('f', 'application/pdf', { fileName: 'r.pdf' })] }]);
      const panel = await openGallery();
      act(() => {
        fireEvent.click(tab(panel, 'Files'));
      });
      await within(panel).findByText('r.pdf');
      expect(within(panel).queryByRole('link', { name: /Save/u })).toBeNull();
      act(() => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Download r.pdf' }));
      });
      const save = await within(panel).findByRole('link', { name: 'Save r.pdf' });
      expect(save.getAttribute('download')).toBe('r.pdf');
    });
  });

  it('has no axe violations on any tab', async () => {
    const snowdrop = await boot();
    await seed(snowdrop, [
      { attachments: [img('a', 'a.png')] },
      { attachments: [att('au', 'audio/mpeg', { fileName: 'song.mp3' })] },
      { attachments: [att('f', 'application/pdf', { fileName: 'r.pdf' })] },
      { body: 'https://example.org/a', previews: [{ url: 'https://example.org/a', title: 'T' }] },
    ]);
    const panel = await openGallery();
    for (const name of ['Media', 'Audio', 'Links', 'Files']) {
      act(() => {
        fireEvent.click(tab(panel, name));
      });
      await settle();
      expect((await axe(panel)).violations.map((v) => v.id)).toEqual([]);
    }
  });
});
