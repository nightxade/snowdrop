/**
 * Safety numbers, identity trust, blocking and message-request responses
 * over signal-cli. SignalCliBackend delegates its `ChatBackend` methods
 * for these here.
 */
import { parseConversationId, type ConversationId } from '@/core/domain';
import { createLogger } from '@/core/lib';
import type { IdentityTrust, MessageRequestResponse, SafetyNumber } from '../types';
import type { Directory } from './directory';
import { isSignalCliError, SignalCliError } from './errors';
import { enrichSendError } from './params';
import type { JsonRpcClient, RpcParams } from './rpc';
import { unknownValue } from './validate';
import { wireIdentities } from './wire';

const log = createLogger('signal-cli');

/** For commands whose result we don't need (it varies across daemon versions). */
const ignoreResult = unknownValue;

export interface SafetyOpsDeps {
  rpc: JsonRpcClient;
  directory: Directory;
  /** Throws unless an account is selected. */
  assertAccount: () => void;
  /** `send` target for a conversation, never addressing a recycled number's new owner. */
  targetOf: (conversationId: ConversationId) => RpcParams;
  /** Whether a number is one of the user's own aliases. */
  isAlias: (id: string) => boolean;
}

export class SafetyOps {
  constructor(private readonly deps: SafetyOpsDeps) {}

  private get rpc(): JsonRpcClient {
    return this.deps.rpc;
  }

  /**
   * `sendMessageRequestResponse`: signal-cli shares (accept) or withdraws
   * (delete) profile sharing with a contact, and tells the user's other
   * devices. For a group it only sends that sync message, so deleting one
   * also quits it (`quitGroup`, local copy included) — a failed quit never
   * blocks the delete: the app hides the chat regardless.
   */
  async respondToMessageRequest(
    conversationId: ConversationId,
    response: MessageRequestResponse,
  ): Promise<void> {
    this.deps.assertAccount();
    const parsed = parseConversationId(conversationId);
    if (!parsed) throw new SignalCliError('user', `Not a conversation id: ${conversationId}`);
    const target = this.deps.targetOf(conversationId);
    if ('noteToSelf' in target) return;
    try {
      await this.rpc.call(
        'sendMessageRequestResponse',
        { ...target, type: response },
        ignoreResult,
      );
    } catch (error) {
      throw enrichSendError(error);
    }
    if (parsed.kind === 'group') {
      if (response === 'delete') {
        try {
          await this.rpc.call('quitGroup', { groupId: parsed.target, delete: true }, ignoreResult);
        } catch (error) {
          log.warn('leaving a deleted group request failed', {
            kind: isSignalCliError(error) ? error.kind : 'unknown',
          });
        }
        this.deps.directory.invalidateGroups();
      }
      return;
    }
    // The contact's `profileSharing` just changed. Re-read in the background:
    // listing contacts can take a while, and the answer is already applied here.
    void this.deps.directory.loadContacts(true);
  }

  /**
   * `listIdentities` for one person: their safety number (digits and scannable
   * bytes) and trust level. Null when signal-cli holds no key for them.
   * Never logged: the number is what the user is meant to compare.
   */
  async getSafetyNumber(contactId: string): Promise<SafetyNumber | null> {
    this.deps.assertAccount();
    const rows = await this.rpc.call('listIdentities', { number: contactId }, wireIdentities);
    const row = rows.find((r) => r.uuid === contactId || r.number === contactId) ?? rows[0];
    if (!row?.safetyNumber) return null;
    return {
      digits: row.safetyNumber,
      qr: row.scannableSafetyNumber ? base64Bytes(row.scannableSafetyNumber) : null,
      trust: trustOf(row.trustLevel),
    };
  }

  /** `trust` with `verifiedSafetyNumber`: signal-cli checks it against the key it holds. */
  async verifyIdentity(contactId: string, digits: string): Promise<void> {
    this.deps.assertAccount();
    await this.rpc.call(
      'trust',
      { recipient: contactId, verifiedSafetyNumber: digits },
      ignoreResult,
    );
  }

  /** `trust` with `trustAllKnownKeys`: accepts the current key, unverified. */
  async approveIdentity(contactId: string): Promise<void> {
    this.deps.assertAccount();
    await this.rpc.call('trust', { recipient: contactId, trustAllKnownKeys: true }, ignoreResult);
  }

  /** `block` / `unblock` (signal-cli syncs both to the phone). */
  async setBlocked(conversationId: ConversationId, blocked: boolean): Promise<void> {
    this.deps.assertAccount();
    const parsed = parseConversationId(conversationId);
    if (!parsed) throw new SignalCliError('user', `Not a conversation id: ${conversationId}`);
    if (parsed.kind === 'direct' && this.deps.isAlias(parsed.target)) return;
    try {
      await this.rpc.call(
        blocked ? 'block' : 'unblock',
        parsed.kind === 'group' ? { groupId: [parsed.target] } : { recipient: [parsed.target] },
        ignoreResult,
      );
    } catch (error) {
      throw enrichSendError(error);
    }
    // Re-read in the background (see respondToMessageRequest): the caller
    // already shows the answer.
    void Promise.all([
      this.deps.directory.loadContacts(true),
      this.deps.directory.loadGroups(true),
    ]).catch((error: unknown) => {
      log.warn('re-reading the directory after a block failed', {
        kind: isSignalCliError(error) ? error.kind : 'unknown',
      });
    });
  }
}

/** signal-cli's trust levels as Signal Desktop's states; anything unknown counts as untrusted. */
function trustOf(level: string): IdentityTrust {
  if (level === 'TRUSTED_VERIFIED') return 'verified';
  if (level === 'TRUSTED_UNVERIFIED') return 'default';
  return 'untrusted';
}

/** Bytes of a base64 string; null when it isn't valid base64. */
function base64Bytes(value: string): number[] | null {
  try {
    return Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
