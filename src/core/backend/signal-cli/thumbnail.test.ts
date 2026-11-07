import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasThumbnailer, thumbnailEdge, THUMBNAIL_MAX_EDGE } from './attachments';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('thumbnailEdge', () => {
  it('sizes the preview for the screen: sharp on dense displays, never below the old size, never huge', () => {
    expect(thumbnailEdge(1)).toBe(THUMBNAIL_MAX_EDGE);
    expect(thumbnailEdge(2)).toBe(800);
    expect(thumbnailEdge(3)).toBe(1200);
    expect(thumbnailEdge(10)).toBe(1600);
    expect(thumbnailEdge(0)).toBe(THUMBNAIL_MAX_EDGE);
    expect(thumbnailEdge(Number.NaN)).toBe(THUMBNAIL_MAX_EDGE);
  });
});

describe('canvasThumbnailer', () => {
  function stub(pixelRatio: number) {
    const sizes: [number, number][] = [];
    vi.stubGlobal('devicePixelRatio', pixelRatio);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 4000, height: 3000, close: vi.fn() })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(w: number, h: number) {
          sizes.push([w, h]);
        }
        getContext() {
          return { drawImage: vi.fn() };
        }
        convertToBlob() {
          return Promise.resolve(new Blob([new Uint8Array(3)], { type: 'image/webp' }));
        }
      },
    );
    return sizes;
  }

  it('draws the preview at the screen-density size, and reports the original dimensions', async () => {
    const sizes = stub(2);
    const thumb = await canvasThumbnailer(new Blob(['x']));
    expect(sizes).toEqual([[800, 600]]);
    expect(thumb).toMatchObject({ width: 4000, height: 3000 });
  });

  it('keeps the small preview on a standard screen', async () => {
    const sizes = stub(1);
    await canvasThumbnailer(new Blob(['x']));
    expect(sizes).toEqual([[512, 384]]);
  });
});
