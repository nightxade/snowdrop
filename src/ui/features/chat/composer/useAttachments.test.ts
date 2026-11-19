import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationIdFor } from '@/core/domain/testing';
import { useAttachments, type StagedFiles } from './useAttachments';

afterEach(() => {
  vi.restoreAllMocks();
});

const chat = conversationIdFor('a');

describe('useAttachments', () => {
  it('releases the previews a voice note replaces', () => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++n}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const held: StagedFiles = new Map();
    const { result } = renderHook(() => useAttachments(chat, held, () => undefined));
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

  it('keeps what is staged for the chat while it is away, previews still valid', () => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++n}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const held: StagedFiles = new Map();
    const first = renderHook(() => useAttachments(chat, held, () => undefined));
    act(() => {
      first.result.current.addFiles([new File(['x'], 'cat.png', { type: 'image/png' })]);
    });
    const url = first.result.current.attachments[0]?.previewUrl;
    first.unmount();
    expect(revoke).not.toHaveBeenCalled();
    const back = renderHook(() => useAttachments(chat, held, () => undefined));
    expect(back.result.current.attachments.map((a) => a.previewUrl)).toEqual([url]);
    const other = renderHook(() => useAttachments(conversationIdFor('b'), held, () => undefined));
    expect(other.result.current.attachments).toEqual([]);
    // Removed, or cleared by a send: gone for good, and released.
    act(() => {
      back.result.current.clearAttachments();
    });
    expect(revoke).toHaveBeenCalledWith(url);
    expect(held.get(chat)).toBeUndefined();
  });
});
