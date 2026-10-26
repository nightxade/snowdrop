import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VOICE_NOTE_MAX_SECONDS } from '@/core/domain';
import { rig, type Rig } from './fakeRecorder';
import { useVoiceRecorder } from './useVoiceRecorder';

afterEach(cleanup);

const stopped = (r: Rig) => r.tracks.every((t) => t.stop.mock.calls.length > 0);

function setup(options: Parameters<typeof rig>[0] = {}) {
  const r = rig(options);
  const onRecorded = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useVoiceRecorder({ onRecorded, onError, deps: r.deps }));
  const recording = async () => {
    await act(async () => {
      hook.result.current.start();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(hook.result.current.phase).toBe('recording');
    });
  };
  return { r, hook, onRecorded, onError, recording };
}

describe('useVoiceRecorder', () => {
  it('goes idle → starting → recording, and shows the live level', async () => {
    const { r, hook, recording } = setup();
    expect(hook.result.current.phase).toBe('idle');
    await recording();
    expect(hook.result.current.startedAt).toBeGreaterThan(0);
    act(() => {
      r.capture.deliver(new Float32Array(4096).fill(0.5));
    });
    expect(hook.result.current.levels).toHaveLength(1);
    expect(hook.result.current.levels[0]).toBeGreaterThan(200);
  });

  it('send hands the recording over to be sent, and the microphone is off', async () => {
    const { r, hook, onRecorded, recording } = setup();
    await recording();
    act(() => {
      hook.result.current.finish('send');
    });
    await vi.waitFor(() => {
      expect(onRecorded).toHaveBeenCalledOnce();
    });
    expect(onRecorded.mock.calls[0]?.[1]).toBe('send');
    expect(onRecorded.mock.calls[0]?.[2]).toBe(false);
    expect(hook.result.current.phase).toBe('idle');
    expect(stopped(r)).toBe(true);
  });

  it('the window losing focus keeps the recording as a draft', async () => {
    const { r, hook, onRecorded, recording } = setup();
    await recording();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await vi.waitFor(() => {
      expect(onRecorded).toHaveBeenCalledOnce();
    });
    expect(onRecorded.mock.calls[0]?.[1]).toBe('draft');
    expect(stopped(r)).toBe(true);
    expect(hook.result.current.phase).toBe('idle');
  });

  it('blur does nothing when nothing records', () => {
    const { onRecorded } = setup();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('Escape cancels, releases the microphone and is claimed ahead of other Escape handlers', async () => {
    const { r, hook, onRecorded, recording } = setup();
    await recording();
    const later = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener('keydown', later);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    window.removeEventListener('keydown', later);
    expect(hook.result.current.phase).toBe('idle');
    expect(stopped(r)).toBe(true);
    expect(onRecorded).not.toHaveBeenCalled();
    // The global Escape (mark read) sees it as already handled.
    expect(later).toHaveReturnedWith(true);
  });

  it('other keys do not cancel', async () => {
    const { hook, recording } = setup();
    await recording();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(hook.result.current.phase).toBe('recording');
  });

  it('turns the microphone off when the composer goes away mid-recording', async () => {
    const { r, hook, onRecorded, recording } = setup();
    await recording();
    hook.unmount();
    expect(stopped(r)).toBe(true);
    expect(r.capture.closed).toBe(1);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('turns the microphone off when the composer goes away while it is still starting', async () => {
    const r = rig({ holdStream: true });
    const hook = renderHook(() =>
      useVoiceRecorder({ onRecorded: vi.fn(), onError: vi.fn(), deps: r.deps }),
    );
    act(() => {
      hook.result.current.start();
    });
    expect(hook.result.current.phase).toBe('starting');
    hook.unmount();
    await act(async () => {
      r.release();
      await Promise.resolve();
    });
    expect(stopped(r)).toBe(true);
  });

  it('explains a refused microphone and goes back to idle', async () => {
    const r = rig();
    r.deps.openStream = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
    const onError = vi.fn();
    const hook = renderHook(() => useVoiceRecorder({ onRecorded: vi.fn(), onError, deps: r.deps }));
    await act(async () => {
      hook.result.current.start();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
    });
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/microphone/u);
    expect(hook.result.current.phase).toBe('idle');
  });

  it('explains a missing microphone', async () => {
    const r = rig();
    r.deps.openStream = () => Promise.reject(new DOMException('none', 'NotFoundError'));
    const onError = vi.fn();
    const hook = renderHook(() => useVoiceRecorder({ onRecorded: vi.fn(), onError, deps: r.deps }));
    await act(async () => {
      hook.result.current.start();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith('No microphone found. Connect one and try again.');
    });
  });

  it('cancel while starting leaves nothing running and nothing reported', async () => {
    const r = rig({ holdStream: true });
    const onError = vi.fn();
    const onRecorded = vi.fn();
    const hook = renderHook(() => useVoiceRecorder({ onRecorded, onError, deps: r.deps }));
    act(() => {
      hook.result.current.start();
    });
    act(() => {
      hook.result.current.cancel();
    });
    await act(async () => {
      r.release();
      await Promise.resolve();
    });
    expect(hook.result.current.phase).toBe('idle');
    expect(stopped(r)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('at the one-hour cap the recording is kept as a draft and flagged', async () => {
    const { r, onRecorded, recording } = setup({ sampleRate: 1000 });
    await recording();
    act(() => {
      r.capture.deliver(new Float32Array(VOICE_NOTE_MAX_SECONDS * 1000));
    });
    await vi.waitFor(() => {
      expect(onRecorded).toHaveBeenCalledOnce();
    });
    expect(onRecorded.mock.calls[0]?.[1]).toBe('draft');
    expect(onRecorded.mock.calls[0]?.[2]).toBe(true);
    expect(stopped(r)).toBe(true);
  });

  it('records again after a cancel', async () => {
    const { hook, recording } = setup();
    await recording();
    act(() => {
      hook.result.current.cancel();
    });
    await recording();
    expect(hook.result.current.phase).toBe('recording');
  });
});
