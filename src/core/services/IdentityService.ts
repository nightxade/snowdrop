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
import type { BackendEvents, ChatBackend, SafetyNumber } from '@/core/backend';
import { directConversationId, type ConversationId } from '@/core/domain';
import { stripBidiControls, toAppError } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';
import { appendLocalSystemLine } from './localSystemLine';
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
  /** When each person's verification was last set, here or (by `at`) on the phone: older syncs are replays. */
  private readonly changedAt = new Map<string, number>();

  constructor(private readonly deps: IdentityServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /**
   * Logs a failure by kind only: an error's own message can name the person
   * (an invalid number) and these calls handle safety numbers.
   */
  private report(error: unknown, context: string): void {
    const kind = toAppError(error).kind;
    this.onError(`error kind: ${kind}`, context);
  }

  /** Whether the connected backend has safety numbers at all (menus hide the rest). */
  get available(): boolean {
    return this.deps.backend.capabilities.features.has('safetyNumbers');
  }

  /** Reads their safety number and records how far their key is trusted. */
  async load(contactId: string): Promise<SafetyNumberResult> {
    const { backend, stores } = this.deps;
    if (!this.available) return { status: 'failed' };
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
    if (!this.available) return 'failed';
    try {
      await backend.verifyIdentity(contactId, digits);
    } catch (error) {
      this.report(error, 'marking a safety number verified failed');
      const now = await this.peek(contactId);
      return now !== null && now.digits !== digits ? 'changed' : 'failed';
    }
    stores.identities.getState().setTrust(contactId, 'verified');
    this.changedAt.set(contactId, this.deps.clock.now());
    await this.noteLine(contactId, 'verified');
    return 'ok';
  }

  /** "Clear verification": the key stays accepted, no longer marked verified. */
  async clearVerification(contactId: string): Promise<boolean> {
    const { backend, stores } = this.deps;
    if (!this.available) return false;
    try {
      await backend.approveIdentity(contactId);
    } catch (error) {
      this.report(error, 'clearing a verification failed');
      return false;
    }
    stores.identities.getState().setTrust(contactId, 'default');
    this.changedAt.set(contactId, this.deps.clock.now());
    await this.noteLine(contactId, 'not-verified');
    return true;
  }

  /**
   * The user marked this person's safety number verified (or not) on their
   * phone. Nothing is sent to the backend: it was done there. `VERIFIED` is
   * verified; `DEFAULT` and `UNVERIFIED` both mean "not verified" (the sync
   * carries no key and Signal's own clients show the same line for both).
   * Desktop writes the "…from another device" line only when the verified
   * state really moves, so this does too: never over an `untrusted` key (the
   * sync names no key, so it can't be known to cover the new one), and a
   * person never known to be verified here has nothing to take back.
   *
   * The cached trust is a guess until the backend is asked, so afterwards it
   * is read again: the badge then shows signal-cli's real trust (it applies
   * the sync itself when the key matches), even for a replay after a restart.
   * A replay writes the line under the same id.
   */
  async applySynced(e: BackendEvents['identityVerified']): Promise<void> {
    const { stores } = this.deps;
    const last = this.changedAt.get(e.contactId);
    if (last !== undefined && e.at <= last) return;
    this.changedAt.set(e.contactId, e.at);
    const trust = stores.identities.getState().trustById[e.contactId];
    if (e.verified && trust !== 'untrusted' && trust !== 'verified') {
      stores.identities.getState().setTrust(e.contactId, 'verified');
      await this.noteLine(e.contactId, 'verified', e.at);
    } else if (!e.verified && trust === 'verified') {
      stores.identities.getState().setTrust(e.contactId, 'default');
      await this.noteLine(e.contactId, 'not-verified', e.at);
    }
    await this.refreshTrust(e.contactId);
  }

  /**
   * "Send anyway": accepts each person's current key, as Desktop does. A key
   * already trusted (including one the user just verified) is left as it is.
   * False if any couldn't be approved.
   */
  async approveAll(contactIds: readonly string[]): Promise<boolean> {
    const { backend, stores } = this.deps;
    if (!this.available) return false;
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
    if (!this.available) return null;
    try {
      return await this.deps.backend.getSafetyNumber(contactId);
    } catch {
      return null;
    }
  }

  /** Desktop's local timeline line for a verification change (only in a chat that exists). */
  private async noteLine(
    contactId: string,
    change: 'verified' | 'not-verified',
    /** Set when it was done on another device, and when: the line says so and does not mark the chat read. */
    otherDeviceAt?: number,
  ): Promise<void> {
    const { stores } = this.deps;
    const other = otherDeviceAt !== undefined;
    const selfId = stores.session.getState().self?.id;
    const conversationId: ConversationId = directConversationId(contactId);
    if (!selfId || !stores.conversations.getState().byId[conversationId]) return;
    const name = stripBidiControls(
      stores.contacts.getState().byId[contactId]?.name ?? 'this person',
    );
    try {
      await appendLocalSystemLine(this.deps, {
        conversationId,
        authorId: selfId,
        text: `You marked your Safety Number with ${name} as ${change === 'verified' ? 'verified' : 'not verified'}${other ? ' from another device' : ''}`,
        tag: other ? `identity-${change}-other` : `identity-${change}`,
        ...(otherDeviceAt !== undefined ? { at: otherDeviceAt, keepUnread: true as const } : {}),
      });
    } catch (error) {
      this.report(error, 'noting a safety number change failed');
    }
  }
}
