/**
 * The imported phone history as SignalCliBackend serves it: opens the archive
 * once per session, answers the `ChatBackend` history methods from it, and
 * supplies the listing with it. SignalCliBackend delegates here and calls
 * `reset` / `close` at its lifecycle points.
 */
import type { ConversationId, Message } from '@/core/domain';
import { createLogger, raceAbort, throwIfAborted, type Clock } from '@/core/lib';
import type {
  AbortOptions,
  HistoryPage,
  HistoryQuery,
  HistoryReadRef,
  HistoryReadState,
} from '../types';
import { describeError, SignalCliError } from './errors';
import { HistoryArchive } from './history/archive';
import { timestamp } from './history/wire';
import type { SelfIdentity } from './identity';
import type { DirectPeers } from './peers';
import type { JsonRpcClient } from './rpc';

const log = createLogger('signal-cli');

export interface HistoryFacadeDeps {
  rpc: JsonRpcClient;
  clock: Clock;
  /** The current account's identity (replaced when an account is selected). */
  identity: () => SelfIdentity;
  /** The current account's direct peers, null before connect. */
  peers: () => DirectPeers | null;
  /** Waits (bounded) for the contact listing the archive's names depend on. */
  contactsForListing: () => Promise<void>;
  /** Throws unless an account is selected. */
  assertAccount: () => void;
}

export class HistoryFacade {
  private history: Promise<HistoryArchive | null> | null = null;
  private abortController = new AbortController();
  /** Whether this session already reported an unreadable history. */
  private warned = false;

  constructor(private readonly deps: HistoryFacadeDeps) {}

  /** A new account was selected: end the old session's open and start afresh. */
  reset(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.warned = false;
    this.history = null;
  }

  /** Disconnect: end the open in flight and drop the archive. */
  close(): void {
    this.abortController.abort();
    this.history = null;
  }

  /** The imported history, or null if it can't be read: it only enriches the listing, never fails it. */
  async historyForListing(): Promise<{
    archive: HistoryArchive | null;
    unreadable: boolean;
  }> {
    try {
      return { archive: await this.loadHistory(), unreadable: false };
    } catch (error) {
      // Once per session, the kind only: nothing from the archive itself.
      if (!this.warned) {
        this.warned = true;
        log.warn('history unavailable for the listing', { reason: describeError(error) });
      }
      return { archive: null, unreadable: true };
    }
  }

  private loadHistory(): Promise<HistoryArchive | null> {
    if (this.history) return this.history;
    const signal = this.abortController.signal;
    const pending = (async () => {
      await this.deps.contactsForListing();
      if (signal.aborted) throw new SignalCliError('aborted', 'History session ended');
      const identity = this.deps.identity();
      const peers = this.deps.peers();
      return HistoryArchive.open(
        this.deps.rpc,
        identity.selfId,
        (id) => identity.resolve(peers?.resolve(id) ?? id),
        signal,
      );
    })();
    this.history = pending;
    void pending.catch(() => {
      if (this.history === pending) this.history = null;
    });
    return pending;
  }

  async historyHasOutgoing(conversationId: ConversationId): Promise<boolean> {
    this.deps.assertAccount();
    const archive = await this.loadHistory();
    const chatId = archive?.directory.chatId(conversationId);
    return archive !== null && chatId !== undefined ? archive.chatHasOutgoing(chatId) : false;
  }

  async fetchHistory(
    conversationId: ConversationId,
    query: HistoryQuery,
    options?: AbortOptions,
  ): Promise<HistoryPage> {
    this.deps.assertAccount();
    throwIfAborted(options?.signal);
    // Opening the archive is shared by every caller, so an abort only stops
    // this caller's wait (and its paging loop), never the shared open.
    return raceAbort(
      (async () => {
        const archive = await this.loadHistory();
        return archive
          ? archive.fetchHistory(conversationId, query, this.deps.clock.now(), options?.signal)
          : { messages: [], hasMoreBefore: false };
      })(),
      options?.signal,
    );
  }

  async remapHistoryMessages(messages: readonly Message[]): Promise<Message[]> {
    this.deps.assertAccount();
    const archive = await this.loadHistory();
    return archive ? archive.remap(messages, this.deps.clock.now()) : [];
  }

  async getHistoryArchiveId(): Promise<string | null> {
    this.deps.assertAccount();
    const archive = await this.loadHistory();
    return archive?.archiveId ?? null;
  }

  readHistory(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]> {
    return this.historyReadStates(messages, true);
  }

  getHistoryReadState(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]> {
    return this.historyReadStates(messages, false);
  }

  private async historyReadStates(
    messages: readonly HistoryReadRef[],
    markRead: boolean,
  ): Promise<HistoryReadState[]> {
    this.deps.assertAccount();
    const archive = await this.loadHistory();
    if (!archive) throw new SignalCliError('io', 'Imported history is unavailable');
    const prefix = `${archive.archiveId}:`;
    const references = new Map(
      messages.map((message) => {
        if (!message.cursor.startsWith(prefix))
          throw new SignalCliError('io', 'History archive changed');
        return [message.cursor.slice(prefix.length), message.id];
      }),
    );
    const states = await archive.read([...references.keys()], markRead);
    return states.map((state) => {
      const id = references.get(state.cursor);
      if (!id)
        throw new SignalCliError('invalid-response', 'History read returned an unknown cursor');
      return {
        id,
        ...(state.expiresAt === undefined ? {} : { expiresAt: timestamp(state.expiresAt) }),
        unavailable: state.unavailable,
      };
    });
  }
}
