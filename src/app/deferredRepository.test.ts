import { describe, expect, it, vi } from 'vitest';
import { deferredAsync } from './deferredRepository';

interface Facade {
  one(a: string): Promise<string>;
  many(a: string, b: number, c: { forceRefresh: boolean }, d: string[]): Promise<number>;
  none(): Promise<void>;
}

describe('deferredAsync', () => {
  it('passes every argument through to the target, with the target as `this`', async () => {
    const target = {
      tag: 'real',
      one: vi.fn(function (this: { tag: string }, a: string) {
        return Promise.resolve(`${this.tag}:${a}`);
      }),
      many: vi.fn(() => Promise.resolve(7)),
      none: vi.fn(() => Promise.resolve()),
    };
    const facade = deferredAsync<Facade>(Promise.resolve(target), 'Facade');
    expect(await facade.one('x')).toBe('real:x');
    const options = { forceRefresh: true };
    expect(await facade.many('a', 2, options, ['d'])).toBe(7);
    expect(target.many).toHaveBeenCalledWith('a', 2, options, ['d']);
    await facade.none();
    expect(target.none).toHaveBeenCalledWith();
  });

  it('rejects when the target fails to load or lacks the method', async () => {
    const failed = deferredAsync<Facade>(Promise.reject(new Error('chunk failed')), 'Facade');
    await expect(failed.none()).rejects.toThrow('chunk failed');
    const empty = deferredAsync<Facade>(Promise.resolve({} as Facade), 'Facade');
    await expect(empty.none()).rejects.toThrow('Facade has no method none');
  });
});
