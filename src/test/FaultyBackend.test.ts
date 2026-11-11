import { describe, expect, it } from 'vitest';
import type { BackendEvents, ChatBackend } from '@/core/backend';
import { FeatureStore } from '@/core/backend/features';
import { Emitter, ManualScheduler } from '@/core/lib';
import { faultyBackend } from './FaultyBackend';

function stub() {
  const emitter = new Emitter<BackendEvents>();
  const calls: string[] = [];
  const backend = {
    kind: 'stub',
    capabilities: new FeatureStore(['history']),
    connect: () => {
      calls.push('connect');
      return Promise.resolve();
    },
    listContacts: () => {
      calls.push('listContacts');
      return Promise.resolve([]);
    },
    getStatus: () => 'online',
    on: (event: keyof BackendEvents, fn: (p: never) => void) => emitter.on(event, fn as never),
  } as unknown as ChatBackend;
  return { backend, emitter, calls };
}

describe('faultyBackend', () => {
  it('fails only the first call of a listed method, as a transient unreachable', async () => {
    const { backend, calls } = stub();
    const faulty = faultyBackend(backend, { failFirst: ['connect'] });
    await expect(faulty.connect()).rejects.toMatchObject({
      kind: 'unreachable',
      transient: true,
      outcome: 'not-sent',
    });
    await expect(faulty.connect()).resolves.toBeUndefined();
    expect(calls).toEqual(['connect']);
    expect(faulty.calls('connect')).toBe(2);
  });

  it('waits on the scheduler before calling through, and leaves the rest alone', async () => {
    const { backend, calls } = stub();
    const scheduler = new ManualScheduler();
    const faulty = faultyBackend(backend, { delay: { listContacts: 500 }, scheduler });
    const pending = faulty.listContacts();
    await Promise.resolve();
    expect(calls).toEqual([]);
    scheduler.advance(499);
    await Promise.resolve();
    expect(calls).toEqual([]);
    scheduler.advance(1);
    await expect(pending).resolves.toEqual([]);
    expect(faulty.getStatus()).toBe('online');
    expect(faulty.kind).toBe('stub');
    expect([...faulty.capabilities.features]).toEqual(['history']);
  });

  it('holds events in order until released, then delivers live', () => {
    const { backend, emitter } = stub();
    const faulty = faultyBackend(backend, { holdEvent: ['caughtUp'] });
    const seen: string[] = [];
    faulty.on('caughtUp', () => seen.push('caughtUp'));
    faulty.on('status', (s) => seen.push(s));
    emitter.emit('caughtUp', undefined);
    emitter.emit('status', 'online');
    emitter.emit('caughtUp', undefined);
    expect(seen).toEqual(['online']);
    expect(faulty.held('caughtUp')).toBe(2);
    faulty.release('caughtUp');
    expect(seen).toEqual(['online', 'caughtUp', 'caughtUp']);
    emitter.emit('caughtUp', undefined);
    expect(seen).toEqual(['online', 'caughtUp', 'caughtUp', 'caughtUp']);
  });
});
