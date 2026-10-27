/**
 * Safety numbers: reading one, marking it verified, clearing that, and
 * approving a changed key so a blocked send can go out, as Signal Desktop does.
 *
 * Every change goes to the backend first; the trust level this device shows
 * (`stores.identities`) and the "You marked your Safety Number…" line follow
 * only once it went through. A safety number is shown to the user and handed
 * back to the backend, never stored or logged here: the store keeps trust
 * levels only, and failures are logged by context alone.
 */
import type { ChatBackend, SafetyNumber } from '@/core/backend';
import {
  directConversationId,
  mergeDuplicate,
  systemMessageId,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';
import { consoleReporter, type ErrorReporter } from './types';

export interface IdentityServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: { now(): number };
  onError?: ErrorReporter;
}

/** What asking for a safety number found. */
export type SafetyNumberResult =
  | { status: 'ready'; number: SafetyNumber }
  /** No key yet: it can't be verified until messages have been exchanged. */
  | { status: 'none' }
  | { status: 'failed' };

/** `changed`: the key moved on while the user was comparing, so nothing was verified. */
export type VerifyResult = 'ok' | 'changed' | 'failed';

export class IdentityService {
  private readonly onError: ErrorReporter;

  constructor(private readonly deps: IdentityServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /**
   * Logs a failure by kind only: an error's own message can name the person
   * (an invalid number) and these calls handle safety numbers.
   */
  private report(error: unknown, context: string): void {
    const kind =
      typeof error === 'object' &&
      error !== null &&
      'kind' in error &&
      typeof error.kind === 'string'
        ? error.kind
        : error instanceof Error
          ? error.constructor.name
          : typeof error;
    this.onError(`error kind: ${kind}`, context);
  }

  /** Whether the connected backend has safety numbers at all (menus hide the rest). */
  get available(): boolean {
    const b = this.deps.backend;
    return (
      b.getSafetyNumber !== undefined &&
      b.verifyIdentity !== undefined &&
      b.approveIdentity !== undefined
    );
  }

  /** Reads their safety number and records how far their key is trusted. */
  async load(contactId: string): Promise<SafetyNumberResult> {
    const { backend, stores } = this.deps;
    if (!backend.getSafetyNumber) return { status: 'failed' };
    try {
      const number = await backend.getSafetyNumber(contactId);
      stores.identities.getState().setTrust(contactId, number?.trust ?? null);
      return number ? { status: 'ready', number } : { status: 'none' };
    } catch (error) {
      this.report(error, 'reading a safety number failed');
      return { status: 'failed' };
    }
  }

  /** Refreshes only the trust level (the verified badge); quiet on failure. */
  async refreshTrust(contactId: string): Promise<void> {
    if (!this.available) return;
    await this.load(contactId);
  }

  /**
   * "Mark as verified" for the number the user compared. If the backend
   * refuses, the number is read again: a different one means the key changed
   * right after the user opened it (`changed`, Desktop's "The safety number you
   * are trying to verify has changed").
   */
  async verify(contactId: string, digits: string): Promise<VerifyResult> {
    const { backend, stores } = this.deps;
    if (!backend.verifyIdentity) return 'failed';
    try {
      await backend.verifyIdentity(contactId, digits);
    } catch (error) {
      this.report(error, 'marking a safety number verified failed');
      const now = await this.peek(contactId);
      return now !== null && now.digits !== digits ? 'changed' : 'failed';
    }
    stores.identities.getState().setTrust(contactId, 'verified');
    await this.noteLine(contactId, 'verified');
    return 'ok';
  }

  /** "Clear verification": the key stays accepted, no longer marked verified. */
  async clearVerification(contactId: string): Promise<boolean> {
    const { backend, stores } = this.deps;
    if (!backend.approveIdentity) return false;
    try {
      await backend.approveIdentity(contactId);
    } catch (error) {
      this.report(error, 'clearing a verification failed');
      return false;
    }
    stores.identities.getState().setTrust(contactId, 'default');
    await this.noteLine(contactId, 'not-verified');
    return true;
  }

  /**
   * "Send anyway": accepts each person's current key, as Desktop does. A key
   * already trusted (including one the user just verified) is left as it is.
   * False if any couldn't be approved.
   */
  async approveAll(contactIds: readonly string[]): Promise<boolean> {
    const { backend, stores } = this.deps;
    if (!backend.approveIdentity) return false;
    let allOk = true;
    for (const id of contactIds) {
      // Asking first: approving a key that is already trusted is an error to the backend.
      const current = await this.peek(id);
      if (current && current.trust !== 'untrusted') {
        stores.identities.getState().setTrust(id, current.trust);
        continue;
      }
      try {
        await backend.approveIdentity(id);
        stores.identities.getState().setTrust(id, 'default');
      } catch (error) {
        this.report(error, 'approving a changed safety number failed');
        allOk = false;
      }
    }
    return allOk;
  }

  /** Notes that a person's key stopped a send, so the badge no longer calls them verified. */
  noteUntrusted(contactIds: readonly string[]): void {
    for (const id of contactIds) this.deps.stores.identities.getState().setTrust(id, 'untrusted');
  }

  private async peek(contactId: string): Promise<SafetyNumber | null> {
    try {
      return (await this.deps.backend.getSafetyNumber?.(contactId)) ?? null;
    } catch {
      return null;
    }
  }

  /** Desktop's local timeline line for a verification change (only in a chat that exists). */
  private async noteLine(contactId: string, change: 'verified' | 'not-verified'): Promise<void> {
    const { repository, stores, clock } = this.deps;
    const selfId = stores.session.getState().self?.id;
    const conversationId: ConversationId = directConversationId(contactId);
    if (!selfId || !stores.conversations.getState().byId[conversationId]) return;
    const name = stripBidiControls(
      stores.contacts.getState().byId[contactId]?.name ?? 'this person',
    );
    const now = clock.now();
    const line: Message = {
      id: systemMessageId(selfId, now, `identity-${change}`),
      conversationId,
      authorId: selfId,
      sentAt: now,
      receivedAt: now,
      body: '',
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'sent',
      kind: 'system',
      systemText: `You marked your Safety Number with ${name} as ${change === 'verified' ? 'verified' : 'not verified'}`,
    };
    try {
      const { message } = await repository.upsert(line, mergeDuplicate);
      stores.messages.getState().appendLive(message);
      stores.conversations.getState().noteLatest(message);
      if (
        message.seq !== undefined &&
        stores.conversations.getState().markRead(conversationId, message.seq)
      )
        await repository.setReadCursor(conversationId, message.seq);
    } catch (error) {
      this.report(error, 'noting a safety number change failed');
    }
  }
}
