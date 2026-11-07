import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverCrop, prepareAvatar } from './avatarImage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareAvatar', () => {
  it('flattens transparency onto white before drawing, so it does not turn black as a JPEG', async () => {
    const calls: string[] = [];
    const context = {
      imageSmoothingQuality: 'low',
      set fillStyle(value: string) {
        calls.push(`fillStyle ${value}`);
      },
      fillRect: (...a: number[]) => calls.push(`fillRect ${a.join(',')}`),
      drawImage: () => calls.push('drawImage'),
    };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 800, height: 600, close: vi.fn() })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return context;
        }
        convertToBlob({ type }: { type: string }) {
          calls.push(`encode ${type}`);
          return Promise.resolve(new Blob([new Uint8Array(3)], { type }));
        }
      },
    );
    const out = await prepareAvatar(new Blob(['x']));
    const side = coverCrop(800, 600).out;
    expect(calls).toEqual([
      'fillStyle #fff',
      `fillRect 0,0,${side},${side}`,
      'drawImage',
      'encode image/jpeg',
    ]);
    expect(out.contentType).toBe('image/jpeg');
  });
});
