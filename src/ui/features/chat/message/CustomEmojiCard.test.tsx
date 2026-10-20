import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { MOCK_EMOJI_PNG } from '@/core/backend/mock/content/customEmoji';
import type { ConversationId, CustomEmojiDelivery } from '@/core/domain';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import { CustomEmojiCard } from './CustomEmojiCard';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

const conversationId = 'conv-1' as ConversationId;
const SUNNY = MOCK_EMOJI_PNG.sunny;
const SKY = MOCK_EMOJI_PNG.sky;

const bytesOf = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));

/** jsdom never decodes images; this one "loads" at a chosen size. */
function stubImage(size: { w: number; h: number } | 'broken' = { w: 48, h: 48 }) {
  class FakeImage {
    naturalWidth = size === 'broken' ? 0 : size.w;
    naturalHeight = size === 'broken' ? 0 : size.h;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      setTimeout(() => {
        if (size === 'broken') this.onerror?.();
        else this.onload?.();
      }, 0);
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

beforeEach(() => {
  stubImage();
});

interface Options {
  name?: string;
  image?: string;
  type?: string;
  size?: number;
  readBlob?: () => Promise<Blob>;
  collection?: { name: string; image: string }[];
}

async function render(options: Options = {}) {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const image = options.image ?? SUNNY;
  const reads = vi.fn(
    options.readBlob ??
      (() => Promise.resolve(new Blob([bytesOf(image)], { type: options.type ?? 'image/png' }))),
  );
  (snowdrop.backend as unknown as Record<string, unknown>).readAttachmentBlob = reads;
  for (const e of options.collection ?? [])
    snowdrop.stores.local
      .getState()
      .saveCustomEmoji({ kind: 'image', name: e.name, dataUrl: e.image });
  const delivery: CustomEmojiDelivery = {
    name: options.name ?? 'partyblob',
    attachment: {
      id: 'em1',
      contentType: 'image/png',
      ...(options.size !== undefined ? { size: options.size } : {}),
    },
  };
  renderWithSnowdrop(
    snowdrop,
    <CustomEmojiCard conversationId={conversationId} delivery={delivery} />,
  );
  await settled();
  return { snowdrop, reads };
}

/** The image is read through a Blob, a FileReader and an Image: wait until the card has an answer. */
const settled = () =>
  waitFor(() => {
    expect(screen.queryByText('Checking image…')).toBeNull();
  });

const library = (snowdrop: Snowdrop) => snowdrop.stores.local.getState().customEmoji;
const addButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Add/u });

describe('CustomEmojiCard', () => {
  it('adds a new emoji to the collection, ready to use at once', async () => {
    const { snowdrop, reads } = await render();
    expect(screen.getByText(':partyblob:')).toBeTruthy();
    expect(document.activeElement).toBe(addButton());
    fireEvent.click(addButton());
    expect(library(snowdrop)).toEqual([{ kind: 'image', name: 'partyblob', dataUrl: SUNNY }]);
    expect(screen.getByRole('status').textContent).toBe('Added. Type :partyblob: to use it.');
    // The image went through the attachment path, bounded by the collection's own limit.
    expect(reads).toHaveBeenCalledWith(conversationId, expect.objectContaining({ id: 'em1' }), {
      maxBytes: 256 * 1024,
    });
  });

  it('says so, and changes nothing, when the same image is already there', async () => {
    const { snowdrop } = await render({ collection: [{ name: 'partyblob', image: SUNNY }] });
    expect(screen.getByRole('status').textContent).toBe('Already in your emoji');
    expect(screen.queryByRole('button', { name: /^Add/u })).toBeNull();
    expect(library(snowdrop)).toHaveLength(1);
  });

  it('recognises the same image saved under another name', async () => {
    const { snowdrop } = await render({ collection: [{ name: 'blobby', image: SUNNY }] });
    expect(screen.getByRole('status').textContent).toBe('Already in your emoji as :blobby:');
    expect(library(snowdrop)).toHaveLength(1);
  });

  it('recognises the same image whatever type label it carries', async () => {
    const png = SUNNY.replace('image/png', 'image/webp');
    await render({ collection: [{ name: 'blobby', image: png }] });
    expect(screen.getByRole('status').textContent).toContain('Already in your emoji as :blobby:');
  });

  it('offers a rename when a different emoji has the name, and never overwrites it', async () => {
    const { snowdrop } = await render({
      image: SKY,
      collection: [{ name: 'partyblob', image: SUNNY }],
    });
    expect(screen.getByRole('status').textContent).toContain(
      'You already have a different :partyblob:',
    );
    const input = screen.getByLabelText<HTMLInputElement>('Name');
    expect(input.value).toBe('partyblob_2');
    expect(document.activeElement).toBe(input);
    expect(addButton().textContent).toBe('Add as :partyblob_2:');

    fireEvent.click(addButton());
    expect(library(snowdrop)).toEqual([
      { kind: 'image', name: 'partyblob', dataUrl: SUNNY },
      { kind: 'image', name: 'partyblob_2', dataUrl: SKY },
    ]);
    expect(screen.getByRole('status').textContent).toBe('Added. Type :partyblob_2: to use it.');
  });

  it('skips taken suffixes and validates a typed name with the collection’s rules', async () => {
    const { snowdrop } = await render({
      image: SKY,
      collection: [
        { name: 'partyblob', image: SUNNY },
        { name: 'partyblob_2', image: SUNNY },
      ],
    });
    const input = screen.getByLabelText<HTMLInputElement>('Name');
    expect(input.value).toBe('partyblob_3');

    fireEvent.change(input, { target: { value: 'partyblob' } });
    expect(screen.getByRole('alert').textContent).toContain('already in your collection');
    expect(addButton().disabled).toBe(true);
    fireEvent.submit(input.closest('form')!);
    expect(library(snowdrop)).toHaveLength(2);

    fireEvent.change(input, { target: { value: 'Not Valid!' } });
    // Lowercased on input, still invalid: spaces and punctuation.
    expect(input.value).toBe('not valid!');
    expect(screen.getByRole('alert').textContent).toContain('1–32 lowercase letters');
    expect(addButton().disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'sky_blob' } });
    expect(addButton().disabled).toBe(false);
    fireEvent.submit(input.closest('form')!);
    expect(library(snowdrop).map((e) => e.name)).toEqual(['partyblob', 'partyblob_2', 'sky_blob']);
  });

  it.each([
    ['is over 256 KB', { size: 300 * 1024 }],
    ['isn’t a PNG, JPEG, GIF or WebP', { type: 'image/svg+xml' }],
  ])('refuses an emoji that %s, and adds nothing', async (message, options) => {
    const { snowdrop, reads } = await render(options);
    expect(screen.getByRole('status').textContent).toContain(message);
    expect(screen.queryByRole('button', { name: /^Add/u })).toBeNull();
    expect(library(snowdrop)).toEqual([]);
    // An advertised size over the limit is never even downloaded.
    if ('size' in options) expect(reads).not.toHaveBeenCalled();
  });

  it('refuses an image bigger than 1024 × 1024 and one that is not an image', async () => {
    stubImage({ w: 2000, h: 40 });
    const first = await render();
    expect(screen.getByRole('status').textContent).toContain('larger than 1024 × 1024');
    expect(library(first.snowdrop)).toEqual([]);
    cleanup();
    stubImage('broken');
    const second = await render();
    expect(screen.getByRole('status').textContent).toContain('couldn’t be read');
    expect(library(second.snowdrop)).toEqual([]);
  });

  it('shows a load failure with a retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const read = vi
      .fn<() => Promise<Blob>>()
      .mockRejectedValueOnce(new Error('gone'))
      .mockImplementation(() => Promise.resolve(new Blob([bytesOf(SUNNY)], { type: 'image/png' })));
    await render({ readBlob: read });
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t load this emoji.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settled();
    await settle();
    expect(addButton().textContent).toBe('Add to my emoji');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports a full collection instead of failing silently', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 32 distinct images, so none of them is "the same image".
    const collection = Array.from({ length: 32 }, (_, i) => ({
      name: `e${i}`,
      image: `data:image/png;base64,${btoa(`distinct-${i}`)}`,
    }));
    const { snowdrop } = await render({ collection });
    await act(async () => {
      fireEvent.click(addButton());
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('collection is full');
    expect(library(snowdrop)).toHaveLength(32);
  });
});
