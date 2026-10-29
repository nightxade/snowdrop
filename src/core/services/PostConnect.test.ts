import { describe, expect, it, vi } from 'vitest';
import { PostConnect } from './PostConnect';

describe('PostConnect', () => {
  it('runs the stages it is asked for, in registration order', async () => {
    const order: string[] = [];
    const post = new PostConnect(vi.fn());
    post.add('after-ready', 'b', () => {
      order.push('b');
    });
    post.add('before-live', 'a', () => {
      order.push('a');
    });
    post.add('after-ready', 'c', async () => {
      await Promise.resolve();
      order.push('c');
    });
    await post.run('before-live');
    expect(order).toEqual(['a']);
    await post.run('after-ready');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('does not run a step that succeeded again', async () => {
    const step = vi.fn();
    const post = new PostConnect(vi.fn());
    post.add('after-ready', 'once', step);
    await post.run('after-ready');
    await post.run('after-ready');
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing step: reports it, runs the rest, and tries it again next time', async () => {
    const onError = vi.fn();
    const flaky = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const after = vi.fn();
    const post = new PostConnect(onError);
    post.add('after-ready', 'flaky', flaky);
    post.add('after-ready', 'after', after);
    await expect(post.run('after-ready')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toContain('flaky');
    expect(after).toHaveBeenCalledTimes(1);
    await post.run('after-ready');
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('runs every step again after reset(), and a run in progress records nothing', async () => {
    const early = vi.fn();
    let release: () => void = () => undefined;
    // Only its first call waits.
    const slow = vi.fn(() =>
      slow.mock.calls.length > 1
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            release = resolve;
          }),
    );
    const late = vi.fn();
    const post = new PostConnect(vi.fn());
    post.add('after-ready', 'early', early);
    post.add('after-ready', 'slow', slow);
    post.add('after-ready', 'late', late);
    const running = post.run('after-ready');
    await new Promise((resolve) => setTimeout(resolve, 0));
    post.reset();
    release();
    await running;
    // The run stopped after the step it was on, and did not mark it done.
    expect(late).not.toHaveBeenCalled();
    await post.run('after-ready');
    expect(early).toHaveBeenCalledTimes(2);
    expect(slow).toHaveBeenCalledTimes(2);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
