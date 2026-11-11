import { describe, expect, it, vi } from 'vitest';
import { FeatureStore } from './features';

describe('FeatureStore', () => {
  it('notifies once per real change, with a new set each time', () => {
    const store = new FeatureStore(['readSync']);
    const before = store.features;
    const fn = vi.fn();
    store.subscribe(fn);
    store.set(['readSync']);
    expect(fn).not.toHaveBeenCalled();
    store.setFeature('phonePrivacy', true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.features).not.toBe(before);
    expect([...store.features].sort()).toEqual(['phonePrivacy', 'readSync']);
  });

  it('a failing listener does not stop the change or the other listeners', () => {
    const store = new FeatureStore();
    const after = vi.fn();
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(after);
    expect(() => {
      store.setFeature('readSync', true);
    }).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(store.features.has('readSync')).toBe(true);
  });
});
