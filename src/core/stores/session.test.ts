import { describe, expect, it } from 'vitest';
import { AppError } from '@/core/lib';
import { createSessionStore, isSynced, phaseForConnectError, sessionSelectors } from './session';

const err = (kind: ConstructorParameters<typeof AppError>[0]) => new AppError(kind, 'x');

describe('session phase', () => {
  it('starts idle and offline', () => {
    const s = createSessionStore().getState();
    expect(s).toMatchObject({ phase: 'idle', link: 'offline', error: null });
    expect(sessionSelectors.ready(s)).toBe(false);
  });

  it('routes a failed first connect by its kind', () => {
    expect(phaseForConnectError(err('no-account'))).toBe('needs-link');
    expect(phaseForConnectError(err('account-required'))).toBe('needs-account');
    expect(phaseForConnectError(err('not-installed'))).toBe('not-installed');
    expect(phaseForConnectError(err('unreachable'))).toBe('failed');
    expect(phaseForConnectError(err('account-unavailable'))).toBe('failed');
  });

  it('connects, syncs and goes online', () => {
    const store = createSessionStore();
    store.getState().markConnecting();
    expect(store.getState().phase).toBe('connecting');
    store.getState().setLink('online');
    expect(store.getState().phase).toBe('connecting'); // not synced yet
    store.getState().markSynced();
    expect(store.getState().phase).toBe('ready');
  });

  it('degrades when the link drops after the initial sync, and recovers', () => {
    const store = createSessionStore();
    store.getState().markConnecting();
    store.getState().setLink('online');
    store.getState().markSynced();
    store.getState().setLink('offline');
    expect(store.getState().phase).toBe('degraded');
    expect(isSynced(store.getState().phase)).toBe(true);
    store.getState().markFailed(err('unreachable'));
    expect(store.getState()).toMatchObject({ phase: 'degraded', link: 'error' });
    expect(store.getState().error?.kind).toBe('unreachable');
    store.getState().setLink('online');
    expect(store.getState()).toMatchObject({ phase: 'ready', error: null });
  });

  it('keeps a setup screen up while a retry connects, and leaves it once online', () => {
    const store = createSessionStore();
    store.getState().markConnecting();
    store.getState().markFailed(err('no-account'));
    expect(store.getState().phase).toBe('needs-link');
    store.getState().markConnecting();
    store.getState().setLink('connecting');
    expect(store.getState().phase).toBe('needs-link');
    store.getState().setLink('offline');
    expect(store.getState().phase).toBe('needs-link');
    store.getState().setLink('online');
    expect(store.getState()).toMatchObject({ phase: 'connecting', error: null });
  });

  it('a failure replaces an earlier setup phase', () => {
    const store = createSessionStore();
    store.getState().markFailed(err('no-account'));
    store.getState().markFailed(err('timeout'));
    expect(store.getState().phase).toBe('failed');
  });

  it('stopping returns to idle and forgets the error', () => {
    const store = createSessionStore();
    store.getState().markFailed(err('timeout'));
    store.getState().markStopped();
    expect(store.getState()).toMatchObject({ phase: 'idle', error: null });
  });
});
