import { describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from './clock';
import { DisposableStore } from './disposables';
import { Emitter } from './emitter';
import { ObservableList } from './observable';

describe('Emitter', () => {
  it('delivers typed events and unsubscribes', () => {
    const e = new Emitter<{ a: number }>();
    const fn = vi.fn();
    const off = e.on('a', fn);
    e.emit('a', 1);
    off();
    e.emit('a', 2);
    expect(fn).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('isolates throwing listeners', () => {
    const onError = vi.fn();
    const e = new Emitter<{ a: number }>(onError);
    const good = vi.fn();
    e.on('a', () => {
      throw new Error('boom');
    });
    e.on('a', good);
    e.emit('a', 1);
    expect(good).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('ManualScheduler', () => {
  it('runs tasks in time order, including ones scheduled while advancing', () => {
    const s = new ManualScheduler(1000);
    const log: string[] = [];
    s.setTimeout(() => {
      log.push(`b@${s.now()}`);
      s.setTimeout(() => log.push(`c@${s.now()}`), 5);
    }, 20);
    s.setTimeout(() => log.push(`a@${s.now()}`), 10);
    const cancel = s.setTimeout(() => log.push('never'), 15);
    cancel();
    s.advance(30);
    expect(log).toEqual(['a@1010', 'b@1020', 'c@1025']);
    expect(s.now()).toBe(1030);
  });

  it('guards against runaway loops', () => {
    const s = new ManualScheduler();
    const loop = (): void => {
      s.setTimeout(loop, 1);
    };
    loop();
    expect(() => {
      s.runAll(50);
    }).toThrow(/limit/u);
  });
});

describe('DisposableStore', () => {
  it('disposes in reverse order, once, isolating errors', () => {
    const onError = vi.fn();
    const store = new DisposableStore(onError);
    const log: number[] = [];
    store.add(() => log.push(1));
    store.add(() => {
      throw new Error('x');
    });
    const early = store.add(() => log.push(3));
    store.add(() => log.push(4));
    early();
    early();
    store.dispose();
    store.dispose();
    expect(log).toEqual([3, 4, 1]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('runs disposers added after disposal immediately', () => {
    const store = new DisposableStore();
    store.dispose();
    const fn = vi.fn();
    store.add(fn);
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('ObservableList', () => {
  it('keeps snapshot identity until changed', () => {
    const list = new ObservableList<string>();
    const fn = vi.fn();
    list.subscribe(fn);
    const empty = list.list();
    expect(list.list()).toBe(empty);
    const remove = list.add('a');
    expect(list.list()).toEqual(['a']);
    remove();
    remove();
    expect(list.list()).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
