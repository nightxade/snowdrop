/**
 * Group commands over signal-cli: editing a conversation, changing or
 * creating a group, and leaving one. SignalCliBackend delegates its
 * `ChatBackend` group methods here. Nothing echoes our own change, so each
 * writes its system line locally through the backend's `emitOwnSystem`.
 */
import {
  avatarKey,
  directConversationId,
  parseConversationId,
  type Conversation,
  type ConversationId,
} from '@/core/domain';
import { createLogger } from '@/core/lib';
import type { ConversationPatch, GroupChange, NewGroupInput } from '../types';
import type { AvatarResolver } from './avatars';
import type { Directory } from './directory';
import { describeError, SignalCliError } from './errors';
import { describeGroupChange, timerSentence } from './normalise/directory';
import { groupChangeParams, newGroupParams } from './params';
import type { JsonRpcClient, RpcParams } from './rpc';
import { unknownValue } from './validate';
import { wireGroupResult } from './wire';

const log = createLogger('signal-cli');

/** For commands whose result we don't need (it varies across daemon versions). */
const ignoreResult = unknownValue;

/** A group change can upload a photo and notify every member. */
const GROUP_TIMEOUT_MS = 60_000;

export interface GroupOpsDeps {
  rpc: JsonRpcClient;
  directory: Directory;
  avatars: AvatarResolver;
  /** Throws unless an account is selected. */
  assertAccount: () => void;
  /** The user's own id (empty before an account is selected). */
  selfId: () => string;
  /** Announces an updated conversation to subscribers. */
  emitConversationUpdated: (conversation: Conversation) => void;
  /** A local system line for a change we made from this device. */
  emitOwnSystem: (
    conversationId: ConversationId,
    sentAt: number,
    text: string,
    kind: string,
  ) => void;
  /** The `timestamp` of a send-like result, else now. */
  resultTimestamp: (result: unknown) => number;
  /** A display name for a person, safe in plain-text system lines. */
  nameOf: (id: string) => string;
  /** Records a changed disappearing-message timer locally. */
  applyTimer: (conversationId: ConversationId, seconds: number) => void;
}

export class GroupOps {
  constructor(private readonly deps: GroupOpsDeps) {}

  private get rpc(): JsonRpcClient {
    return this.deps.rpc;
  }

  /**
   * Group: `updateGroup`. DM timer: `updateContact --expiration`, which also
   * un-hides a contact you had hidden on your phone (signal-cli behaviour).
   * Our other devices learn the change from Signal, but nothing echoes it to
   * *this* client, so the system line is written locally.
   */
  async updateConversation(
    conversationId: ConversationId,
    patch: ConversationPatch,
  ): Promise<void> {
    this.deps.assertAccount();
    const parsed = parseConversationId(conversationId);
    if (!parsed) throw new SignalCliError('user', `Not a conversation id: ${conversationId}`);
    if (parsed.kind === 'direct') {
      if (patch.title !== undefined || patch.description !== undefined) {
        throw new SignalCliError('user', 'Direct conversations have no editable name or topic');
      }
      if (patch.expireTimerSec === undefined) return;
      const result = await this.rpc.call(
        'updateContact',
        { recipient: parsed.target, expiration: patch.expireTimerSec },
        ignoreResult,
      );
      const dm = directConversationId(parsed.target);
      this.deps.applyTimer(dm, patch.expireTimerSec);
      this.deps.emitOwnSystem(
        dm,
        this.deps.resultTimestamp(result),
        timerSentence('You', patch.expireTimerSec),
        'timer',
      );
      return;
    }
    const params: RpcParams = { groupId: parsed.target };
    if (patch.title !== undefined) params.name = patch.title;
    if (patch.description !== undefined) params.description = patch.description;
    if (patch.expireTimerSec !== undefined) params.expiration = patch.expireTimerSec;
    const result = await this.rpc.call('updateGroup', params, ignoreResult);
    const current = this.deps.directory.group(conversationId);
    if (!current) return;
    const next: Conversation = { ...current };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.expireTimerSec !== undefined) next.expireTimerSec = patch.expireTimerSec;
    this.deps.directory.setGroup(next);
    this.deps.emitConversationUpdated(next);
    const lines = describeGroupChange(current, next, 'You', (id) => this.deps.nameOf(id), true);
    if (lines.length > 0) {
      this.deps.emitOwnSystem(
        conversationId,
        this.deps.resultTimestamp(result),
        lines.join(' '),
        'group',
      );
    }
  }

  /**
   * `updateGroup`: one call for any mix of details, members, admins,
   * permissions and link. Nothing echoes our own change, so afterwards the
   * group is re-listed (which is what the directory keeps current, and what
   * "what changed" is diffed from) and the system line is written locally.
   */
  async updateGroup(conversationId: ConversationId, change: GroupChange): Promise<void> {
    this.deps.assertAccount();
    const parsed = parseConversationId(conversationId);
    if (parsed?.kind !== 'group') throw new SignalCliError('user', 'That is not a group.');
    const params = groupChangeParams(parsed.target, change);
    const before = this.deps.directory.group(conversationId);
    const result = await this.rpc.call('updateGroup', params, wireGroupResult, {
      timeoutMs: GROUP_TIMEOUT_MS,
    });
    let after = before;
    try {
      after = (await this.deps.directory.fetchGroup(parsed.target)) ?? before;
    } catch (error) {
      this.deps.directory.invalidateGroups();
      log.warn('re-listing a group after changing it failed', { kind: describeError(error) });
    }
    if (after && change.avatar !== undefined) {
      after = this.deps.directory.rememberGroupAvatar(conversationId, change.avatar) ?? after;
      this.deps.avatars.prime(avatarKey({ kind: 'group', id: conversationId }), change.avatar);
    }
    if (!after) return;
    this.deps.emitConversationUpdated(after);
    const lines = describeGroupChange(before, after, 'You', (id) => this.deps.nameOf(id), true);
    if (lines.length > 0) {
      const sentAt = this.deps.resultTimestamp(result);
      this.deps.emitOwnSystem(conversationId, sentAt, lines.join(' '), 'group');
    }
  }

  /** `updateGroup` with no `groupId` makes the group; its first system line is ours. */
  async createGroup(input: NewGroupInput): Promise<Conversation> {
    this.deps.assertAccount();
    const result = await this.rpc.call('updateGroup', newGroupParams(input), wireGroupResult, {
      timeoutMs: GROUP_TIMEOUT_MS,
    });
    if (!result.groupId) {
      throw new SignalCliError('invalid-response', 'signal-cli did not say which group it made.');
    }
    let group = await this.deps.directory.fetchGroup(result.groupId);
    if (!group) throw new SignalCliError('invalid-response', 'The new group could not be read.');
    if (input.avatar !== undefined) {
      group = this.deps.directory.rememberGroupAvatar(group.id, input.avatar) ?? group;
      this.deps.avatars.prime(avatarKey({ kind: 'group', id: group.id }), input.avatar);
    }
    this.deps.emitConversationUpdated(group);
    this.deps.emitOwnSystem(
      group.id,
      this.deps.resultTimestamp(result),
      'You created the group.',
      'group',
    );
    return group;
  }

  /**
   * `quitGroup`, without `delete`: signal-cli keeps the group (listed as not
   * joined) and this device keeps the chat, read-only, as Signal Desktop does.
   * The last admin has to hand the role on (`admin`), or signal-cli refuses.
   * Nothing echoes our own leaving, so the "You left the group." line is ours.
   */
  async leaveGroup(
    conversationId: ConversationId,
    newAdminIds: readonly string[] = [],
  ): Promise<void> {
    this.deps.assertAccount();
    const parsed = parseConversationId(conversationId);
    if (parsed?.kind !== 'group') throw new SignalCliError('user', 'That is not a group.');
    const before = this.deps.directory.group(conversationId);
    const params: RpcParams = { groupId: parsed.target };
    if (newAdminIds.length > 0) params.admin = [...newAdminIds];
    const result = await this.rpc.call('quitGroup', params, ignoreResult, {
      timeoutMs: GROUP_TIMEOUT_MS,
    });
    this.deps.directory.markLeft(parsed.target);
    let after: Conversation | undefined;
    try {
      after = (await this.deps.directory.fetchGroup(parsed.target)) ?? undefined;
    } catch (error) {
      log.warn('re-listing a group after leaving it failed', { kind: describeError(error) });
    }
    after ??= before ? this.deps.directory.leftConversation(before, this.deps.selfId()) : undefined;
    if (!after) return;
    this.deps.emitConversationUpdated(after);
    this.deps.emitOwnSystem(
      conversationId,
      this.deps.resultTimestamp(result),
      'You left the group.',
      'group',
    );
  }
}
