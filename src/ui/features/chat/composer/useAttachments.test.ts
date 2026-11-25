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

  it('keeps the files that fit under the per-message limit and refuses the rest, saying so', () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
    const errors: (string | null)[] = [];
    const held: StagedFiles = new Map();
    const { result } = renderHook(() => useAttachments(chat, held, (e) => errors.push(e)));
    const file = (n: number) => new File(['x'], `f${n}.txt`, { type: 'text/plain' });
    act(() => {
      result.current.addFiles(Array.from({ length: 30 }, (_, i) => file(i)));
    });
    expect(result.current.attachments).toHaveLength(30);
    act(() => {
      result.current.addFiles([file(30), file(31), file(32)]);
    });
    expect(result.current.attachments).toHaveLength(32);
    expect(result.current.attachments.at(-1)?.file.name).toBe('f31.txt');
    expect(errors.at(-1)).toBe(
      '\u201cf32.txt\u201d isn\u2019t added: a message has at most 32 files.',
    );
    act(() => {
      result.current.addFiles([file(40), file(41)]);
    });
    expect(result.current.attachments).toHaveLength(32);
    expect(errors.at(-1)).toBe(
      '\u201cf40.txt\u201d and \u201cf41.txt\u201d aren\u2019t added: a message has at most 32 files.',
    );
  });
});
