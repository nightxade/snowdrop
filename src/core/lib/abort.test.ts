import { describe, expect, it } from 'vitest';
import { abortedError, anySignal, isAborted, raceAbort, throwIfAborted } from './abort';

describe('abort helpers', () => {
  it('throwIfAborted reports a call that never started', () => {
    expect(() => {
      throwIfAborted(undefined);
    }).not.toThrow();
    const controller = new AbortController();
    controller.abort();
    expect(() => {
      throwIfAborted(controller.signal);
    }).toThrow(expect.objectContaining({ kind: 'aborted', outcome: 'not-sent' }) as Error);
  });

  it('raceAbort rejects at once, leaves the work running, and ignores its late result', async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const raced = raceAbort(work, controller.signal);
    controller.abort();
    const error = await raced.catch((e: unknown) => e);
    expect(isAborted(error)).toBe(true);
    finish('late');
    await expect(work).resolves.toBe('late');
  });

  it('raceAbort passes the work’s own result and failure through', async () => {
    const controller = new AbortController();
    await expect(raceAbort(Promise.resolve(1), controller.signal)).resolves.toBe(1);
    await expect(raceAbort(Promise.reject(new Error('boom')), controller.signal)).rejects.toThrow(
      'boom',
    );
  });

  it('anySignal fires when any source does, and stops listening on dispose', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = anySignal([a.signal, undefined, b.signal]);
    expect(merged.signal.aborted).toBe(false);
    b.abort();
    expect(merged.signal.aborted).toBe(true);

    const c = new AbortController();
    const quiet = anySignal([c.signal]);
    quiet.dispose();
    c.abort();
    expect(quiet.signal.aborted).toBe(false);

    const done = new AbortController();
    done.abort();
    expect(anySignal([done.signal]).signal.aborted).toBe(true);
  });

  it('abortedError is an aborted AppError', () => {
    expect(abortedError()).toMatchObject({ kind: 'aborted', outcome: 'unknown' });
  });
});
