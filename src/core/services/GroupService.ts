/**
 * What the user can do to a group: change its details, members, admins,
 * permissions and link; make a new one; leave one.
 *
 * Every edit goes to the backend first and the group on screen changes when
 * the backend reports it (nothing is optimistic: Signal refuses an edit when
 * our role is out of date or the group has moved on, and a wrong guess shown
 * as done is worse than a moment's wait). Before asking, our own role is
 * checked against the same rules Signal Desktop applies, so a request that
 * would only be refused is never sent. Edits to one group run one at a time.
 *
 * Failures resolve to a short, content-free sentence for the dialog that
 * asked (never a name, number or id) and are logged by kind only.
 */
import type { ChatBackend, GroupChange, NewGroupInput } from '@/core/backend';
import {
  canAddMembers,
  canEditGroupInfo,
  canManageGroup,
  GROUP_LIMITS,
  mustChooseNewAdmin,
  normalizeGroupTitle,
  type Conversation,
  type ConversationId,
} from '@/core/domain';
import { graphemes } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';
import { consoleReporter, type ErrorReporter } from './types';

export interface GroupServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: { now(): number };
  onError?: ErrorReporter;
}

/** A group we made, ready to open. */
export type CreateGroupResult = { ok: true; id: ConversationId } | { ok: false; message: string };

const NOT_ALLOWED = "You can't make that change in this group.";
const CONNECTION = 'Check your connection and try again.';

/** The sentence for a failed group call, from the error's transport `kind` (when it has one). */
export function groupFailureMessage(error: unknown): string {
  const kind =
    typeof error === 'object' && error !== null && 'kind' in error ? error.kind : undefined;
  switch (kind) {
    case 'rate-limited':
      return 'Signal is limiting group changes right now. Wait a little, then try again.';
    case 'user':
      return 'Signal refused that change. The group may have changed: close this and try again.';
    case 'unregistered':
      return 'Someone you chose is not on Signal.';
    case 'unreachable':
    case 'timeout':
    case 'io':
      return `Couldn't reach Signal. ${CONNECTION}`;
    default:
      return `That didn't work. ${CONNECTION}`;
  }
}

export class GroupService {
  private readonly onError: ErrorReporter;
  /** The last edit queued per group, so the next waits for it. */
  private readonly tails = new Map<ConversationId, Promise<unknown>>();

  constructor(private readonly deps: GroupServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /** Whether the connected backend can edit, make and leave groups. */
  get available(): boolean {
    const b = this.deps.backend;
    return b.updateGroup !== undefined && b.createGroup !== undefined && b.leaveGroup !== undefined;
  }

  private selfId(): string | null {
    return this.deps.stores.session.getState().self?.id ?? null;
  }

  private group(id: ConversationId): Conversation | undefined {
    const c = this.deps.stores.conversations.getState().byId[id];
    return c?.kind === 'group' ? c : undefined;
  }

  /**
   * Whether our role allows `change` in this group; the same split Desktop
   * makes: details and adding follow the group's rules, everything else is
   * for admins. Approving a request is an admin's even where members may add.
   */
  allows(id: ConversationId, change: GroupChange): boolean {
    const group = this.group(id);
    const self = this.selfId();
    if (!group || !self) return false;
    const adds = change.addMemberIds ?? [];
    const asking = new Set(group.requestingMemberIds ?? []);
    const approves = adds.some((m) => asking.has(m));
    const admin =
      (change.removeMemberIds?.length ?? 0) > 0 ||
      (change.addAdminIds?.length ?? 0) > 0 ||
      (change.removeAdminIds?.length ?? 0) > 0 ||
      change.link !== undefined ||
      change.resetLink === true ||
      change.permissions !== undefined ||
      approves;
    if (admin && !canManageGroup(group, self)) return false;
    const details =
      change.title !== undefined || change.description !== undefined || change.avatar !== undefined;
    if (details && !canEditGroupInfo(group, self)) return false;
    if (adds.length > 0 && !canAddMembers(group, self)) return false;
    return true;
  }

  /**
   * Applies `change`. Resolves to null when it went through (the group and
   * the timeline have been updated by then), else to what to tell the user.
   */
  async update(id: ConversationId, change: GroupChange): Promise<string | null> {
    const update = this.deps.backend.updateGroup?.bind(this.deps.backend);
    if (!update) return `Groups can't be changed with this connection.`;
    if (!this.allows(id, change)) return NOT_ALLOWED;
    if (change.title !== undefined) {
      const title = normalizeGroupTitle(change.title);
      if (!title) return 'A group needs a name.';
      if (graphemes(title).length > GROUP_LIMITS.title) return 'That group name is too long.';
    }
    if (
      change.description !== undefined &&
      graphemes(change.description).length > GROUP_LIMITS.description
    ) {
      return 'That description is too long.';
    }
    const prior = this.tails.get(id) ?? Promise.resolve();
    const run = prior.then(async (): Promise<string | null> => {
      // Re-checked once it is our turn: the change before ours may have changed our role.
      if (!this.allows(id, change)) return NOT_ALLOWED;
      try {
        await update(id, change);
        return null;
      } catch (error) {
        this.onError(error, 'group update failed');
        return groupFailureMessage(error);
      }
    });
    this.tails.set(id, run);
    try {
      return await run;
    } finally {
      if (this.tails.get(id) === run) this.tails.delete(id);
    }
  }

  /** Makes a group with us as its admin. */
  async create(input: NewGroupInput): Promise<CreateGroupResult> {
    const create = this.deps.backend.createGroup?.bind(this.deps.backend);
    if (!create) return { ok: false, message: `Groups can't be made with this connection.` };
    const title = normalizeGroupTitle(input.title);
    if (!title) return { ok: false, message: 'A group needs a name.' };
    if (graphemes(title).length > GROUP_LIMITS.title) {
      return { ok: false, message: 'That group name is too long.' };
    }
    try {
      const group = await create({ ...input, title });
      this.deps.stores.conversations.getState().upsert(group);
      // Our own doing, not someone writing to us: no request to answer.
      this.deps.stores.local.getState().markAccepted(group.id, this.deps.clock.now());
      return { ok: true, id: group.id };
    } catch (error) {
      this.onError(error, 'creating a group failed');
      return { ok: false, message: groupFailureMessage(error) };
    }
  }

  /**
   * Leaves a group. The chat stays, read-only (the backend reports the group
   * as left). The last admin names who takes over (`newAdminIds`); without
   * one the backend would refuse, so say so before asking.
   */
  async leave(id: ConversationId, newAdminIds: readonly string[] = []): Promise<string | null> {
    const leave = this.deps.backend.leaveGroup?.bind(this.deps.backend);
    if (!leave) return `Groups can't be left with this connection.`;
    const group = this.group(id);
    const self = this.selfId();
    if (!group || group.left) return NOT_ALLOWED;
    const needsAdmin = mustChooseNewAdmin(group, self);
    const chosen = newAdminIds.filter((m) => group.memberIds.includes(m) && m !== self);
    if (needsAdmin && chosen.length === 0) {
      return 'Choose at least one new admin before you leave.';
    }
    try {
      await leave(id, needsAdmin ? chosen : []);
    } catch (error) {
      this.onError(error, 'leaving a group failed');
      return groupFailureMessage(error);
    }
    // The backend announces the left group itself; this only makes sure of it.
    const now = this.group(id);
    if (now && !now.left) {
      this.deps.stores.conversations.getState().upsert({
        ...now,
        memberIds: now.memberIds.filter((m) => m !== self),
        adminIds: now.adminIds.filter((m) => m !== self),
        left: true,
      });
    }
    return null;
  }
}
