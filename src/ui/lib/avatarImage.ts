import { PROFILE_AVATAR_MAX_SIDE } from '@/core/domain';

export interface PreparedAvatar {
  contentType: 'image/jpeg';
  base64: string;
}

/** What the editor accepts in its file picker (the same formats Signal Desktop does). */
export const AVATAR_ACCEPT = '.gif,.jpg,.jpeg,.png,.webp,image/gif,image/jpeg,image/png,image/webp';

const MIN_SIDE = 2;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The largest centred square of a `width`×`height` image, and the side it shrinks to. */
export function coverCrop(
  width: number,
  height: number,
): { sx: number; sy: number; side: number; out: number } {
  const side = Math.min(width, height);
  return {
    sx: Math.floor((width - side) / 2),
    sy: Math.floor((height - side) / 2),
    side,
    out: Math.min(side, PROFILE_AVATAR_MAX_SIDE),
  };
}

/**
 * Turns a picked image into a profile photo the way Signal Desktop does:
 * the largest centred square, shrunk to at most 512 pixels a side, saved as a
 * JPEG. Rejects when the file isn't an image the browser can read, or is
 * smaller than two pixels.
 */
export async function prepareAvatar(file: Blob): Promise<PreparedAvatar> {
  const bitmap = await createImageBitmap(file);
  try {
    if (Math.min(bitmap.width, bitmap.height) < MIN_SIDE) throw new Error('image too small');
    const { sx, sy, side, out } = coverCrop(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(out, out);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.imageSmoothingQuality = 'medium';
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, out, out);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg' });
    return {
      contentType: 'image/jpeg',
      base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    };
  } finally {
    bitmap.close();
  }
}
