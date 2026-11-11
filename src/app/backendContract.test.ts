// @vitest-environment node
/**
 * Runs the backend contract (src/test/backendContract.ts) against each adapter
 * and each adapter behind `deferredBackend`. Lives in the composition root
 * because that is the one place allowed to import every adapter.
 */
import {
  SELF_ACI,
  SELF_NUMBER,
  ALICE,
  ALICE_NUMBER,
  GROUP_ID,
  T0,
  dataMessage,
  receive,
} from '@/core/backend/signal-cli/fixtures/envelopes';
import type { ChatBackend } from '@/core/backend';
import { MockBackend, MockBackendError } from '@/core/backend/mock';
import { SignalCliBackend } from '@/core/backend/signal-cli';
import { FakeDaemon, flush } from '@/core/backend/signal-cli/testing';
import { makeMessage } from '@/core/domain/testing';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { describeBackendContract, type ContractSubject } from '@/test/backendContract';
import { BackendRegistry, BUILTIN_BACKENDS } from './backends';
import { deferredBackend } from './deferredBackend';

const registry = new BackendRegistry(BUILTIN_BACKENDS);

function mockSubject(): ContractSubject {
  const scheduler = new ManualScheduler(T0);
  const backend = new MockBackend({ latencyMs: 0, scheduler, clock: scheduler });
  let counter = 0;
  return {
    backend,
    settle: () => Promise.resolve(),
    async deliverIncoming(body) {
      const conv = (await backend.listConversations()).find((c) => c.kind === 'direct');
      if (!conv) throw new Error('the demo has no direct conversation');
      const authorId = conv.memberIds.find((id) => id !== backend.world.self.id) ?? 'peer';
      counter++;
      backend.deliver(
        makeMessage({ conversationId: conv.id, authorId, sentAt: T0 + counter, body }),
      );
    },
    // The demo fails the next command; its connect never fails.
    breakTransport: () => {
      backend.failNext(new MockBackendError('Simulated network failure', 'unreachable'));
    },
    restoreTransport: () => undefined,
  };
}

const contactWire = (uuid: string, number: string, name: string) => ({
  number,
  uuid,
  username: null,
  name,
  givenName: null,
  familyName: null,
  nickName: null,
  nickGivenName: null,
  nickFamilyName: null,
  note: null,
  color: null,
  isArchived: false,
  isBlocked: false,
  isHidden: false,
  messageExpirationTime: 0,
  profileSharing: true,
  unregistered: false,
  profile: {
    lastUpdateTimestamp: T0,
    givenName: name.split(' ')[0],
    familyName: null,
    about: null,
    aboutEmoji: null,
    hasAvatar: false,
    mobileCoinAddress: null,
  },
});

const groupWire = {
  id: GROUP_ID,
  name: 'Climbing Club',
  description: '',
  isMember: true,
  isBlocked: false,
  messageExpirationTime: 0,
  members: [
    { number: SELF_NUMBER, uuid: SELF_ACI, isAdmin: true },
    { number: ALICE_NUMBER, uuid: ALICE, isAdmin: false },
  ],
  pendingMembers: [],
  requestingMembers: [],
  admins: [{ number: SELF_NUMBER, uuid: SELF_ACI }],
  banned: [],
  permissionAddMember: 'EVERY_MEMBER',
  permissionEditDetails: 'EVERY_MEMBER',
  permissionSendMessage: 'EVERY_MEMBER',
  groupInviteLink: null,
  isTerminated: false,
};

function signalCliSubject(): ContractSubject {
  let sentAt = T0 + 1000;
  const daemon = new FakeDaemon()
    .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
    .reply('listContacts', [
      contactWire(SELF_ACI, SELF_NUMBER, 'Me Myself'),
      contactWire(ALICE, ALICE_NUMBER, 'Alice Liddell'),
    ])
    .reply('listGroups', [groupWire])
    .handle('send', () => ({ result: { timestamp: ++sentAt, results: [] } }));
  const scheduler = new ManualScheduler(T0 + 1000);
  const backend = new SignalCliBackend({
    baseUrl: '/signal-cli',
    account: null,
    fetch: daemon.fetch,
    clock: scheduler,
    scheduler,
    random: () => 0,
    storage: createMemoryStorage(),
    debug: () => undefined,
  });
  let counter = 0;
  const push = (event: string, data: unknown): void => {
    daemon.lastStream?.push(
      `id:run-${++counter}\nevent:${event}\ndata:${JSON.stringify(data)}\n\n`,
    );
  };
  return {
    backend,
    async settle() {
      await flush();
      await backend.idle();
    },
    deliverIncoming(body) {
      push(
        'receive',
        receive('alice', {
          dataMessage: dataMessage({ timestamp: T0 + 10 + counter, message: body }),
        }),
      );
      return flush();
    },
    signalDrained() {
      push('receiveCaughtUp', { account: SELF_ACI });
      return flush();
    },
    breakTransport: () => {
      daemon.up = false;
    },
    restoreTransport: () => {
      daemon.up = true;
    },
  };
}

/** The same adapter reached the way the app reaches it. */
function deferred(make: () => ContractSubject): () => ContractSubject {
  return () => {
    const subject = make();
    const registration = registry.get(subject.backend.kind)!;
    const wrapped: ChatBackend = deferredBackend(
      registration.kind,
      registration.features,
      Promise.resolve(subject.backend),
    );
    return { ...subject, backend: wrapped };
  };
}

const mockOptions = {
  staticFeatures: MockBackend.FEATURES,
  caughtUp: 'on-connect',
  sendWhileOffline: 'rejects',
  unsupported: { call: (b: ChatBackend) => b.readPhonePrivacy(), kind: 'unsupported' },
} as const;

// A daemon that doesn't report `phonePrivacy` gates the method behind its own
// user-facing error (the copy is shown as-is), not `UnsupportedError`.
const signalCliOptions = {
  staticFeatures: SignalCliBackend.FEATURES,
  caughtUp: 'from-transport',
  sendWhileOffline: 'attempts',
  connectFailureStatus: 'error',
  unsupported: { call: (b: ChatBackend) => b.readPhonePrivacy(), kind: 'user' },
} as const;

describeBackendContract('MockBackend', mockSubject, mockOptions);
describeBackendContract('MockBackend via deferredBackend', deferred(mockSubject), mockOptions);
describeBackendContract('SignalCliBackend', signalCliSubject, signalCliOptions);
describeBackendContract(
  'SignalCliBackend via deferredBackend',
  deferred(signalCliSubject),
  signalCliOptions,
);
