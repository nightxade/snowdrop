/**
 * The privacy settings the user's phone syncs to this device (read receipts,
 * typing indicators, link previews).
 *
 * Owns reading them (with retry and backoff, reported once per outage),
 * changing them from Settings (applied at once, reverted on failure), and
 * handing held read receipts on to ReadStateService the moment the settings
 * are known.
 *
 * SyncService decides when to read (connect, reconnect, the phone changing
 * them) and cancels the retry timer when it stops.
 */
import type { ChatBackend, PhonePrivacyPatch } from '@/core/backend';
import type { Cancel, Scheduler, Unsubscribe } from '@/core/lib';
import { UNKNOWN_PHONE_PRIVACY, type Stores } from '@/core/stores';
import type { ReadStateService } from './ReadStateService';
import { consoleReporter, type ErrorReporter } from './types';

export interface PhonePrivacyServiceDeps {
  backend: ChatBackend;
  stores: Stores;
  scheduler: Scheduler;
  readState: ReadStateService;
  onError?: ErrorReporter;
}

/**
 * Retry cadence for a failed read of the phone's privacy settings. Until one
 * succeeds nothing that depends on them is sent (see `effectivePrivacy`), so
 * a few quick tries cover a daemon that is still starting up.
 */
const PHONE_PRIVACY_RETRY_MS = 3_000;
/** Retries at the base delay before backing off (doubling) up to the cap; it never gives up while connected. */
const PHONE_PRIVACY_FAST_RETRIES = 8;
const PHONE_PRIVACY_RETRY_CAP_MS = 60_000;

export class PhonePrivacyService {
  private readonly onError: ErrorReporter;
  /** Latest phone-privacy read wins; an older answer arriving late is ignored. */
  private readSeq = 0;
  private retryCancel: Cancel | null = null;
  private retries = 0;
  /** Whether the current run of failed reads has been reported (once per outage). */
  private failureReported = false;

  constructor(private readonly deps: PhonePrivacyServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /**
   * Reads the privacy settings the user's phone syncs to this device (only
   * where the backend can), or marks them unsupported. Never throws: a failed
   * read leaves them pending (nothing depending on them is sent) and retries.
   */
  async refresh(isRetry = false): Promise<void> {
    const { backend, stores } = this.deps;
    // A read triggered by a connect or the phone starts over; only its own retries count up.
    if (!isRetry) this.retries = 0;
    const session = stores.session.getState();
    if (!backend.capabilities.features.has('phonePrivacy')) {
      session.setPhonePrivacy({ status: 'unsupported', values: UNKNOWN_PHONE_PRIVACY });
      return;
    }
    // A daemon that newly reports support starts from "unknown", not local settings.
    if (session.phonePrivacy.status === 'unsupported') {
      session.setPhonePrivacy({ status: 'pending', values: UNKNOWN_PHONE_PRIVACY });
    }
    const seq = ++this.readSeq;
    try {
      const values = await backend.readPhonePrivacy();
      if (seq !== this.readSeq) return;
      this.retries = 0;
      this.failureReported = false;
      stores.session.getState().setPhonePrivacy({ status: 'ready', values });
    } catch (error) {
      if (seq !== this.readSeq) return;
      if (!this.failureReported) {
        this.failureReported = true;
        this.onError(error, 'reading the phone privacy settings failed');
      }
      this.retryCancel?.();
      // Giving up would leave receipts, typing and link previews off (and read
      // sync held) until the next connect, so keep trying, ever more slowly.
      const slow = Math.min(Math.max(0, this.retries - PHONE_PRIVACY_FAST_RETRIES), 10);
      const delay = Math.min(PHONE_PRIVACY_RETRY_MS * 2 ** slow, PHONE_PRIVACY_RETRY_CAP_MS);
      this.retries++;
      this.retryCancel = this.deps.scheduler.setTimeout(() => {
        this.retryCancel = null;
        void this.refresh(true);
      }, delay);
    }
  }

  /**
   * Settings → Privacy: changes read receipts / typing indicators / link
   * previews on the phone's account (stored by signal-cli and synced to the
   * phone, as Signal Desktop does). Applies at once and reverts on failure.
   * Returns false when the phone's settings aren't known (the caller then
   * edits the local setting) or the change failed.
   */
  async update(patch: PhonePrivacyPatch): Promise<boolean> {
    const { backend, stores } = this.deps;
    const current = stores.session.getState().phonePrivacy;
    if (current.status !== 'ready' || !backend.capabilities.features.has('phonePrivacyUpdate'))
      return false;
    const previous = current.values;
    stores.session.getState().setPhonePrivacy({
      status: 'ready',
      values: { ...previous, ...patch },
    });
    try {
      await backend.updatePhonePrivacy(patch);
      return true;
    } catch (error) {
      this.onError(error, 'privacy setting update failed');
      // Put back only what this change touched, unless a newer read replaced it.
      const now = stores.session.getState().phonePrivacy;
      if (now.status === 'ready') {
        const reverted = { ...now.values };
        for (const key of Object.keys(patch) as (keyof PhonePrivacyPatch)[]) {
          if (reverted[key] === patch[key]) reverted[key] = previous[key];
        }
        stores.session.getState().setPhonePrivacy({ status: 'ready', values: reverted });
      }
      return false;
    }
  }

  /**
   * Held read receipts leave (or are dropped) the moment the settings are
   * known. Returns what undoes the subscription.
   */
  watch(): Unsubscribe {
    return this.deps.stores.session.subscribe((state, prev) => {
      if (state.phonePrivacy !== prev.phonePrivacy && state.phonePrivacy.status !== 'pending') {
        this.deps.readState.flushHeldReceipts();
      }
    });
  }

  /** Stops a pending retry (the connection is being closed). */
  cancelRetry(): void {
    this.retryCancel?.();
    this.retryCancel = null;
  }

  /** Drops an answer still on its way, and any pending retry. */
  teardown(): void {
    this.readSeq++;
    this.cancelRetry();
  }
}
