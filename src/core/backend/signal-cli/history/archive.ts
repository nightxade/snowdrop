import { SignalCliError } from '../errors';
import type { ConversationId, Message, MessageId } from '@/core/domain';
import type { HistoryPage, HistoryQuery } from '../../types';
import type { CallOptions, JsonRpcClient } from '../rpc';
import { isRecord } from '../validate';
import { BackupDirectory } from './directory';
import { backupMessage } from './messages';
import { decimal, historyPage, historyReadStates, timestamp } from './wire';

type ArchivePage = ReturnType<typeof historyPage>;
const PAGE_SIZE = 500;
/** Pages of a chat `chatHasOutgoing` reads at most. */
const OUTGOING_SCAN_PAGES = 4;

function invalid(message: string): never {
  throw new SignalCliError('invalid-response', `History: ${message}`);
}

/** An account-bound snapshot. A partial directory is never exposed to callers. */
export class HistoryArchive {
  /** chatLatestMessageAt answers, per chat, for this archive's lifetime. */
  private readonly latestMessageAt = new Map<string, Promise<number | undefined>>();
  /** chatHasOutgoing answers, same lifetime. */
  private readonly hasOutgoing = new Map<string, Promise<boolean>>();

  private constructor(
    private readonly rpc: JsonRpcClient,
    private readonly options: CallOptions,
    readonly archiveId: string,
    readonly directory: BackupDirectory,
  ) {}

  static async open(
    rpc: JsonRpcClient,
    selfId: string,
    resolve?: (id: string) => string,
    signal?: AbortSignal,
  ): Promise<HistoryArchive | null> {
    const options: CallOptions = {
      account: rpc.account ?? null,
      ...(signal ? { signal } : {}),
    };
    const directory = new BackupDirectory(selfId, resolve);
    let archiveId: string | undefined;
    let after = '0';
    for (;;) {
      let page: ArchivePage;
      try {
        page = await rpc.call(
          'getHistoryDirectory',
          {
            limit: PAGE_SIZE,
            ...(archiveId ? { archiveId, after } : {}),
          },
          historyPage,
          options,
        );
      } catch (error) {
        if (!archiveId && error instanceof SignalCliError && error.kind === 'method-not-found')
          return null;
        throw error;
      }
      if (!page.archiveId) {
        if (!archiveId && !page.entries.length && !page.hasMore) return null;
        invalid('missing archive id');
      }
      if (archiveId && page.archiveId !== archiveId) invalid('archive changed during pagination');
      archiveId = page.archiveId;
      validateCursors(page, PAGE_SIZE);
      for (const entry of page.entries) {
        if (BigInt(entry.cursor) <= BigInt(after)) invalid('directory cursor did not advance');
        if (!isRecord(entry.frame.recipient) && !isRecord(entry.frame.chat))
          invalid('unexpected directory frame');
        directory.add(entry.frame);
        after = entry.cursor;
      }
      if (page.entries.length && page.nextCursor !== after) invalid('invalid directory cursor');
      if (!page.hasMore) return new HistoryArchive(rpc, options, archiveId, directory);
    }
  }

  /** Returns raw ChatItems in archive order, without sorting by sender time. */
  async chatPage(chatId: string, before: string | undefined, limit: number): Promise<ArchivePage> {
    decimal(chatId);
    if (before !== undefined) decimal(before);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE)
      throw new RangeError('History page limit must be between 1 and 500');
    const page = await this.rpc.call(
      'getHistoryChat',
      {
        archiveId: this.archiveId,
        chatId,
        limit,
        ...(before === undefined ? {} : { before }),
      },
      historyPage,
      this.options,
    );
    if (page.archiveId !== this.archiveId) invalid('archive changed during pagination');
    validateCursors(page, limit);
    for (const entry of page.entries) {
      if (before !== undefined && BigInt(entry.cursor) >= BigInt(before))
        invalid('chat cursor is outside the requested range');
      if (!isRecord(entry.frame.chatItem) || decimal(entry.frame.chatItem.chatId) !== chatId)
        invalid('unexpected chat frame');
    }
    if (page.entries.length && page.nextCursor !== page.entries[0]?.cursor)
      invalid('invalid chat continuation cursor');
    return page;
  }

  /**
   * The newest real message's own timestamp (Backups.proto ChatItem's
   * `dateSent` — the sender's clock, present on every item whether incoming
   * or outgoing), or undefined if the chat has none. Used both to decide
   * whether a history-only conversation belongs in the list at all, and to
   * order it like the phone (see SignalCliBackend.listConversations):
   * `dateSent` rather than `dateReceived`/`dateServerSent` (incoming-only,
   * and this device's own receive/server time rather than a value every
   * item carries) so it lines up with a live message's own `sentAt` (see
   * `notePeer`) — a backlog delivered in a burst at startup then still lands
   * in the same relative order the phone shows, not clustered around "now".
   *
   * Matches the phone, which lists/orders a chat only by a real message:
   * system entries (`updateMessage` — safety number changes, "joined
   * Signal", profile and timer changes) don't count. Pages newest-first and
   * stops at the first real entry (scanning each page back to front, since
   * `chatPage` orders entries oldest-to-newest), so it's one indexed lookup
   * for almost every chat (patches/signal-cli 0005's chat_id index); there's
   * no per-chat max/count query to use instead. Cached: the archive is a
   * snapshot, so later listings (every refresh) don't repeat the lookups. A
   * failed lookup isn't cached.
   */
  chatLatestMessageAt(chatId: string): Promise<number | undefined> {
    let answer = this.latestMessageAt.get(chatId);
    if (!answer) {
      answer = this.findLatestReal(chatId);
      this.latestMessageAt.set(chatId, answer);
      answer.catch(() => this.latestMessageAt.delete(chatId));
    }
    return answer;
  }

  /**
   * Whether the user sent at least one real message in this chat (a chat they
   * started from their phone): Desktop counts that as accepting it. Looks
   * newest-first, one page of PAGE_SIZE at a time, and stops at the first
   * outgoing message, so for a chat the user has ever answered recently it is
   * one indexed lookup; a chat they never wrote in is read to its start,
   * bounded to OUTGOING_SCAN_PAGES pages (the newest 2000 items) — beyond
   * that it is treated as "no", and the chat is judged by the usual rules.
   * Cached for the archive's lifetime like `chatLatestMessageAt`.
   */
  chatHasOutgoing(chatId: string): Promise<boolean> {
    let answer = this.hasOutgoing.get(chatId);
    if (!answer) {
      answer = this.findOutgoing(chatId);
      this.hasOutgoing.set(chatId, answer);
      answer.catch(() => this.hasOutgoing.delete(chatId));
    }
    return answer;
  }

  private async findOutgoing(chatId: string): Promise<boolean> {
    let before: string | undefined;
    for (let pages = 0; pages < OUTGOING_SCAN_PAGES; pages++) {
      const page = await this.chatPage(chatId, before, PAGE_SIZE);
      for (const entry of page.entries) {
        const item = entry.frame.chatItem as Record<string, unknown>;
        if (isRecord(item.outgoing) && !isRecord(item.updateMessage)) return true;
      }
      if (!page.hasMore) return false;
      before = page.nextCursor;
    }
    return false;
  }

  private async findLatestReal(chatId: string): Promise<number | undefined> {
    let before: string | undefined;
    for (let limit = 8; ; limit = PAGE_SIZE) {
      const page = await this.chatPage(chatId, before, limit);
      // chatPage has already checked every entry's chatItem is a record;
      // entries page oldest-to-newest, so scan back to front for the newest.
      const items = page.entries.map((entry) => entry.frame.chatItem as Record<string, unknown>);
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item && !isRecord(item.updateMessage)) return timestamp(item.dateSent);
      }
      if (!page.hasMore) return undefined;
      before = page.nextCursor;
    }
  }

  /** `markRead: false` inspects deadlines without starting timers during recovery. */
  async read(
    cursors: readonly string[],
    markRead = true,
  ): Promise<ReturnType<typeof historyReadStates>> {
    if (!cursors.length || cursors.length > PAGE_SIZE || new Set(cursors).size !== cursors.length)
      throw new RangeError('History read requires 1..500 distinct cursors');
    for (const cursor of cursors) {
      if (decimal(cursor) === '0') throw new RangeError('History cursors must be positive');
    }
    const states = await this.rpc.call(
      markRead ? 'readHistory' : 'getHistoryReadState',
      {
        archiveId: this.archiveId,
        cursors: [...cursors],
      },
      historyReadStates,
      this.options,
    );
    if (
      states.length !== cursors.length ||
      new Set(states.map((state) => state.cursor)).size !== states.length
    )
      invalid('read response omitted or duplicated a cursor');
    for (const state of states) {
      if (!cursors.includes(state.cursor)) invalid('read response returned an unrequested cursor');
      if (state.expiresAt !== undefined) timestamp(state.expiresAt);
    }
    return states;
  }

  /** Resolve pre-archive cache boundaries without comparing sender clocks. */
  private async findCursor(
    chatId: string,
    id: MessageId,
    now: number,
  ): Promise<string | undefined> {
    let before: string | undefined;
    for (;;) {
      const page = await this.chatPage(chatId, before, PAGE_SIZE);
      for (const entry of page.entries) {
        const message = backupMessage({
          archiveId: this.archiveId,
          cursor: entry.cursor,
          item: entry.frame.chatItem as Record<string, unknown>,
          directory: this.directory,
          now,
        });
        if (message?.id === id) return entry.cursor;
      }
      if (!page.hasMore) return undefined;
      before = page.nextCursor;
    }
  }

  /**
   * Re-maps stored messages straight from the archive, one indexed lookup
   * per row: the single entry at their own cursor (a page of 1 "before"
   * cursor+1). Skips rows that carry no cursor of this archive, whose entry
   * is gone or no longer maps to the same message (expired, unsupported).
   */
  async remap(messages: readonly Message[], now: number): Promise<Message[]> {
    const prefix = `${this.archiveId}:`;
    const out: Message[] = [];
    for (const stored of messages) {
      const raw = stored.historyCursor;
      if (!raw?.startsWith(prefix)) continue;
      const chatId = this.directory.chatId(stored.conversationId);
      if (!chatId) continue;
      let cursor: string;
      try {
        cursor = decimal(raw.slice(prefix.length));
      } catch {
        continue;
      }
      const page = await this.chatPage(chatId, (BigInt(cursor) + 1n).toString(), 1);
      const entry = page.entries[0];
      if (entry?.cursor !== cursor) continue;
      const message = backupMessage({
        archiveId: this.archiveId,
        cursor,
        item: entry.frame.chatItem as Record<string, unknown>,
        directory: this.directory,
        now,
      });
      if (message?.id === stored.id) out.push(message);
    }
    return out;
  }

  async fetchHistory(
    conversationId: ConversationId,
    query: HistoryQuery,
    now: number,
  ): Promise<HistoryPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > PAGE_SIZE)
      throw new RangeError('History page limit must be between 1 and 500');
    const chatId = this.directory.chatId(conversationId);
    if (!chatId) return { messages: [], hasMoreBefore: false };
    let before: string | undefined;
    if (query.beforeCursor !== undefined) {
      const prefix = `${this.archiveId}:`;
      if (!query.beforeCursor.startsWith(prefix)) invalid('archive changed during pagination');
      before = decimal(query.beforeCursor.slice(prefix.length));
    } else if (query.beforeId !== undefined) {
      before = await this.findCursor(chatId, query.beforeId, now);
    }
    const hasExactBoundary = before !== undefined;
    const messages: Message[] = [];
    for (;;) {
      const page = await this.chatPage(chatId, before, PAGE_SIZE);
      const converted = page.entries.flatMap((entry) => {
        const message = backupMessage({
          archiveId: this.archiveId,
          cursor: entry.cursor,
          item: entry.frame.chatItem as Record<string, unknown>,
          directory: this.directory,
          now,
        });
        // Existing local messages may predate archive support and have no
        // ordinal cursor. Use the legacy timestamp only if their identity
        // could not be found (for example, a message newer than the archive).
        if (
          message &&
          !hasExactBoundary &&
          query.before !== undefined &&
          message.sentAt >= query.before
        )
          return [];
        return message ? [message] : [];
      });
      const needed = query.limit - messages.length;
      messages.unshift(...converted.slice(-needed));
      if (messages.length === query.limit || !page.hasMore) {
        return { messages, hasMoreBefore: page.hasMore || converted.length > needed };
      }
      // Unsupported/expired items may consume a whole wire page. Keep looking,
      // advancing the archive cursor even when none can enter the timeline.
      before = page.nextCursor;
    }
  }
}

function validateCursors(page: ArchivePage, limit: number): void {
  if (page.entries.length > limit) invalid('page exceeds requested limit');
  if (page.hasMore && (!page.entries.length || page.nextCursor === undefined))
    invalid('continuation cursor did not advance');
  let previous = 0n;
  for (const entry of page.entries) {
    const cursor = BigInt(entry.cursor);
    if (cursor <= previous) invalid('page cursors are not strictly ascending');
    previous = cursor;
  }
}
