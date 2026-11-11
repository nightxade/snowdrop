import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { makeMessage } from '@/core/domain/testing';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { IdentityService } from './IdentityService';
import { SendService } from './SendService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const send = new SendService({ backend, repository, stores, clock: scheduler });
  const identity = new IdentityService({ backend, repository, stores, clock: scheduler });
  return { backend, send, identity };
}

describe('what a menu or service offers follows the backend features, not its methods', () => {
  it('SendService reads pins, admin delete, polls and conversation settings from the features', () => {
    const { backend, send } = setup();
    expect(send.capabilities).toEqual({
      pin: true,
      adminDelete: true,
      updateConversation: true,
      polls: true,
    });
    for (const feature of ['pins', 'adminDelete', 'conversationSettings', 'polls'] as const)
      backend.capabilities.setFeature(feature, false);
    expect(send.capabilities).toEqual({
      pin: false,
      adminDelete: false,
      updateConversation: false,
      polls: false,
    });
  });

  it('does not call the backend for a pin, an admin delete or a setting it lacks the feature for', async () => {
    const { backend, send } = setup();
    for (const feature of ['pins', 'adminDelete', 'conversationSettings'] as const)
      backend.capabilities.setFeature(feature, false);
    const pin = vi.spyOn(backend, 'pinMessage');
    const adminDelete = vi.spyOn(backend, 'adminDelete');
    const update = vi.spyOn(backend, 'updateConversation');
    const message = makeMessage({ sentAt: 5, authorId: 'ana' });
    expect(await send.pin(message.conversationId, message, true)).toBe(false);
    expect(await send.adminDelete(message.conversationId, message)).toBe(false);
    expect(await send.updateConversation(message.conversationId, { expireTimerSec: 60 })).toBe(
      false,
    );
    expect(pin).not.toHaveBeenCalled();
    expect(adminDelete).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('IdentityService offers safety numbers only with the feature, and asks nothing without it', async () => {
    const { backend, identity } = setup();
    expect(identity.available).toBe(true);
    backend.capabilities.setFeature('safetyNumbers', false);
    const read = vi.spyOn(backend, 'getSafetyNumber');
    const verify = vi.spyOn(backend, 'verifyIdentity');
    expect(identity.available).toBe(false);
    expect(await identity.load('ana')).toEqual({ status: 'failed' });
    expect(await identity.verify('ana', '123')).toBe('failed');
    expect(await identity.clearVerification('ana')).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});
