import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { StickerPackDetails } from '@/core/backend';
import type { ConversationId, StickerContent } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { useStickerPacks } from '../composer/useStickerPacks';
import { StickerPackDialog } from './StickerPackDialog';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

const KEY = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
const conversationId = 'conv-1' as ConversationId;
const sticker: StickerContent = { packId: 'ab12', stickerId: 1, emoji: '🧣' };
const pack = (patch: Partial<StickerPackDetails> = {}): StickerPackDetails => ({
  packId: 'ab12',
  title: 'Winter Folk',
  author: 'Frostline Studio',
  installed: false,
  cover: { stickerId: 0, emoji: '⛄', url: 'data:image/svg+xml,a' },
  stickers: [
    { stickerId: 0, emoji: '⛄', url: 'data:image/svg+xml,a' },
    { stickerId: 1, emoji: '🧣', url: 'data:image/svg+xml,b' },
    { stickerId: 2, emoji: '', url: 'data:image/svg+xml,c' },
  ],
  ...patch,
});

interface Fakes {
  getStickerPack?: (s: StickerContent) => Promise<StickerPackDetails>;
  installStickerPack?: (s: StickerContent) => Promise<void>;
  supports?: boolean;
}

async function open(fakes: Fakes = {}, onOpenChange = vi.fn()) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const backend = snowdrop.backend as unknown as Record<string, unknown>;
  backend.getStickerPack = fakes.getStickerPack ?? (() => Promise.resolve(pack()));
  backend.installStickerPack = fakes.installStickerPack ?? (() => Promise.resolve());
  backend.supportsStickerPackInstall = () => fakes.supports ?? true;
  renderWithSnowdrop(
    snowdrop,
    <StickerPackDialog
      conversationId={conversationId}
      sticker={sticker}
      onOpenChange={onOpenChange}
    />,
  );
  await settle(snowdrop);
  return { snowdrop, onOpenChange };
}

const installButton = () =>
  within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', {
    name: /^(Install|Installing…|Installed|Try again)$/u,
  });

describe('StickerPackDialog', () => {
  it('shows the pack: title, author, count and every sticker, with Install focused', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: 'Winter Folk' });
    expect(within(dialog).getByText('By Frostline Studio')).toBeTruthy();
    expect(within(dialog).getByText('3 stickers')).toBeTruthy();
    const list = within(dialog).getByRole('list');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['⛄ sticker', '🧣 sticker', 'Sticker']);
    expect(installButton().textContent).toBe('Install');
    expect(document.activeElement).toBe(installButton());
    expect(within(dialog).getByText('Also adds the pack on your phone.')).toBeTruthy();
  });

  it('shows a loading state while the pack is being fetched', async () => {
    let resolve!: (p: StickerPackDetails) => void;
    await open({
      getStickerPack: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    expect(screen.getByRole('dialog', { name: 'Sticker pack' })).toBeTruthy();
    expect(screen.getByText('Loading sticker pack…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    await act(async () => {
      resolve(pack());
      await Promise.resolve();
    });
    expect(screen.getByRole('dialog', { name: 'Winter Folk' })).toBeTruthy();
  });

  it('installs: busy, then Installed and disabled, and a second click does nothing', async () => {
    let finish!: () => void;
    const install = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    await open({ installStickerPack: install });
    fireEvent.click(installButton());
    await settle();
    expect(install).toHaveBeenCalledWith(sticker);
    expect(installButton().textContent).toBe('Installing…');
    expect(installButton().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Installing…');
    fireEvent.click(installButton());
    expect(install).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(installButton().textContent).toBe('Installed');
    expect(installButton().getAttribute('aria-disabled')).toBe('true');
    // Focus stays on the button (it is not `disabled`), so the keyboard doesn't lose its place.
    expect(document.activeElement).toBe(installButton());
    expect(screen.getByRole('status').textContent).toContain('Installed.');
    fireEvent.click(installButton());
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('opens an already-installed pack as Installed, with nothing to do', async () => {
    const install = vi.fn(() => Promise.resolve());
    await open({
      getStickerPack: () => Promise.resolve(pack({ installed: true })),
      installStickerPack: install,
    });
    expect(installButton().textContent).toBe('Installed');
    expect(installButton().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('This pack is in your sticker picker.')).toBeTruthy();
    fireEvent.click(installButton());
    expect(install).not.toHaveBeenCalled();
  });

  it('shows an install failure inline and lets you try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const install = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error(`could not install ab12 ${KEY}`))
      .mockResolvedValueOnce(undefined);
    await open({ installStickerPack: install });
    fireEvent.click(installButton());
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t install this pack');
    expect(installButton().textContent).toBe('Try again');
    expect(installButton().getAttribute('aria-disabled')).toBeNull();
    // Logged by kind only: the message names the pack and may carry a key.
    const logged = warn.mock.calls.map((c) => c.map((p) => JSON.stringify(p)).join(' ')).join('\n');
    expect(logged).toContain('sticker pack install failed');
    expect(logged).not.toContain('ab12');
    expect(logged).not.toContain(KEY);

    fireEvent.click(installButton());
    await settle();
    expect(installButton().textContent).toBe('Installed');
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('keeps Install disabled, with the reason, on a signal-cli without the install patch', async () => {
    const install = vi.fn(() => Promise.resolve());
    await open({ installStickerPack: install, supports: false });
    expect(installButton().textContent).toBe('Install');
    expect(installButton().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/needs a newer signal-cli/u)).toBeTruthy();
    fireEvent.click(installButton());
    expect(install).not.toHaveBeenCalled();
  });

  it('shows a load failure with a retry that loads the pack', async () => {
    const get = vi
      .fn<() => Promise<StickerPackDetails>>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(pack());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await open({ getStickerPack: get });
    expect(screen.getByText('Couldn’t load this sticker pack')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.getByRole('dialog', { name: 'Winter Folk' })).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape', async () => {
    const { onOpenChange } = await open();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('refreshes the picker’s listing after an install, so the pack shows without a restart', async () => {
    const snowdrop = await bootSnowdrop();
    snowdrops.push(snowdrop);
    const backend = snowdrop.backend as unknown as Record<string, unknown>;
    let installed = false;
    backend.listStickerPacks = () =>
      Promise.resolve(installed ? [{ ...pack(), installed: undefined }] : []);
    backend.getStickerPack = () => Promise.resolve(pack());
    backend.installStickerPack = () => {
      installed = true;
      return Promise.resolve();
    };
    backend.supportsStickerPackInstall = () => true;

    const seen: string[] = [];
    function Probe() {
      const state = useStickerPacks(true);
      seen.push(state.status === 'ready' ? `ready:${state.packs.length}` : state.status);
      return null;
    }
    const first = renderWithSnowdrop(snowdrop, <Probe />);
    await settle(snowdrop);
    expect(seen.at(-1)).toBe('ready:0');
    first.unmount();

    renderWithSnowdrop(
      snowdrop,
      <StickerPackDialog
        conversationId={conversationId}
        sticker={sticker}
        onOpenChange={vi.fn()}
      />,
    );
    await settle(snowdrop);
    fireEvent.click(installButton());
    await settle(snowdrop);
    cleanup();

    seen.length = 0;
    renderWithSnowdrop(snowdrop, <Probe />);
    // The stale empty listing is not shown again: it starts from loading.
    expect(seen[0]).toBe('loading');
    await settle(snowdrop);
    expect(seen.at(-1)).toBe('ready:1');
  });
});
