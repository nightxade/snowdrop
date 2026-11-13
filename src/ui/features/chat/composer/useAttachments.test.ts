import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAttachments } from './useAttachments';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAttachments', () => {
  it('releases the previews a voice note replaces', () => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++n}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { result } = renderHook(() => useAttachments(() => undefined));
    act(() => {
      result.current.addFiles([new File(['x'], 'cat.png', { type: 'image/png' })]);
    });
    const photo = result.current.attachments[0]?.previewUrl;
    expect(photo).toBeDefined();
    act(() => {
      result.current.addVoiceNote({ blob: new Blob(['v']), durationSeconds: 2, waveform: [1, 2] });
    });
    expect(revoke).toHaveBeenCalledWith(photo);
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]?.voiceNote).toBe(true);
  });
});
