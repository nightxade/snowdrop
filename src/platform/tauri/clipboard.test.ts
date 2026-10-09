import { expect, it, vi } from 'vitest';
import { readClipboardFiles } from './clipboard';
vi.mock('./ipc', () => ({ tauriIpc: {} }));

it('reconstructs clipboard files without changing their bytes or media type', async () => {
  const invoke = vi
    .fn()
    .mockResolvedValue([{ name: 'image.png', contentType: 'image/png', base64: 'AAH/' }]);
  const files = await readClipboardFiles({ invoke, listen: vi.fn() });
  expect(invoke).toHaveBeenCalledWith('clipboard_read_files');
  expect(files[0]?.name).toBe('image.png');
  expect(files[0]?.type).toBe('image/png');
  expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(new Uint8Array([0, 1, 255]));
});
