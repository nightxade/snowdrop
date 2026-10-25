import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import type { ProfileUpdate } from '@/core/backend';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

const text = { givenName: 'Ada', familyName: 'Lovelace', about: 'Hello', aboutEmoji: '🙂' };

async function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const stores = createStores();
  const onError = vi.fn();
  const sync = new SyncService({
    backend,
    repository: new MemoryMessageRepository(),
    stores,
    clock: scheduler,
    scheduler,
    receipts: new ReceiptBuffer(),
    onError,
  });
  await sync.start();
  const self = () => stores.session.getState().self!;
  return { backend, stores, sync, onError, self };
}

describe('SyncService.updateProfile', () => {
  it('refreshes self in the session and contacts stores at once', async () => {
    const { stores, sync, self } = await setup();
    const id = self().id;
    await expect(sync.updateProfile(text)).resolves.toBeNull();
    expect(self()).toMatchObject({
      isSelf: true,
      profileGivenName: 'Ada',
      profileFamilyName: 'Lovelace',
      profileName: 'Ada Lovelace',
      about: 'Hello',
      aboutEmoji: '🙂',
    });
    expect(stores.contacts.getState().byId[id]).toMatchObject({ profileName: 'Ada Lovelace' });
  });

  it('clears the about text and last name when they are saved empty', async () => {
    const { sync, self } = await setup();
    await sync.updateProfile(text);
    await sync.updateProfile({ ...text, familyName: '', about: '', aboutEmoji: '' });
    expect(self().profileName).toBe('Ada');
    expect(self()).not.toHaveProperty('profileFamilyName');
    expect(self()).not.toHaveProperty('about');
    expect(self()).not.toHaveProperty('aboutEmoji');
  });

  it('keeps a photo just set for the session, until it is removed', async () => {
    const { sync, self } = await setup();
    const avatar = { contentType: 'image/jpeg', base64: 'AAAA' };
    await sync.updateProfile({ ...text, avatar });
    expect(self().avatarUrl).toBe('data:image/jpeg;base64,AAAA');
    // Saving only text leaves the photo as it was.
    await sync.updateProfile({ ...text, about: 'Again' });
    expect(self().avatarUrl).toBe('data:image/jpeg;base64,AAAA');
    await sync.updateProfile({ ...text, avatar: null });
    expect(self()).not.toHaveProperty('avatarUrl');
  });

  it('leaves everything alone and returns a message when the backend fails', async () => {
    const { backend, sync, self, onError } = await setup();
    const before = self();
    backend.updateProfile = (_update: ProfileUpdate) => Promise.reject(new Error('offline'));
    const message = await sync.updateProfile(text);
    expect(message).toMatch(/couldn't save/iu);
    expect(self()).toEqual(before);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('says so when the backend cannot change a profile', async () => {
    const { backend, sync } = await setup();
    // @ts-expect-error: simulating a backend without the capability
    backend.updateProfile = undefined;
    await expect(sync.updateProfile(text)).resolves.toMatch(/can't change/iu);
  });
});
