import { useStore } from 'zustand';
import {
  mustChooseNewAdmin,
  parseConversationId,
  type Contact,
  type Conversation,
  type ConversationId,
} from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import { sessionSelectors } from '@/core/stores';
import { useStores, type AppServices } from '@/ui/hooks';

/** What the block dialogs and menus need to know about the person or group behind a conversation id. */
export interface BlockTarget {
  group: boolean;
  /** Safe to put in a sentence: no bidi controls. */
  name: string;
  blocked: boolean;
  /** A group whose only admin is the user: Desktop won't block it until they hand the role on. */
  onlyAdmin: boolean;
  /** The user themselves (Note to Self), who can't be blocked. */
  self: boolean;
}

/**
 * The block state of a direct chat's person or of a group, read reactively.
 * A person with no chat (a blocked contact the user never wrote to) is
 * found through the contact list. `undefined` when nothing is known of it.
 */
export function useBlockTarget(id: ConversationId): BlockTarget | undefined {
  const { conversations, contacts, session } = useStores();
  const conversation = useStore(conversations, (s) => s.byId[id]);
  const parsed = parseConversationId(id);
  const contact = useStore(contacts, (s) =>
    parsed?.kind === 'direct' ? s.byId[parsed.target] : undefined,
  );
  const selfId = useStore(session, sessionSelectors.selfId);
  return describeBlockTarget(id, conversation, contact, selfId);
}

/** Non-React twin of `useBlockTarget`, for menus built at open time. */
export function readBlockTarget(app: AppServices, id: ConversationId): BlockTarget | undefined {
  const { stores } = app;
  const parsed = parseConversationId(id);
  return describeBlockTarget(
    id,
    stores.conversations.getState().byId[id],
    parsed?.kind === 'direct' ? stores.contacts.getState().byId[parsed.target] : undefined,
    stores.session.getState().self?.id ?? null,
  );
}

function describeBlockTarget(
  id: ConversationId,
  conversation: Conversation | undefined,
  contact: Contact | undefined,
  selfId: string | null,
): BlockTarget | undefined {
  const parsed = parseConversationId(id);
  if (!parsed) return undefined;
  if (parsed.kind === 'direct') {
    if (!contact && !conversation) return undefined;
    const self = contact?.isSelf === true || parsed.target === selfId;
    return {
      group: false,
      name: stripBidiControls(contact?.name ?? conversation?.title ?? 'this person'),
      blocked: contact?.blocked === true,
      onlyAdmin: false,
      self,
    };
  }
  if (!conversation) return undefined;
  return {
    group: true,
    name: stripBidiControls(conversation.title),
    blocked: conversation.blocked === true,
    onlyAdmin: mustChooseNewAdmin(conversation, selfId),
    self: false,
  };
}

/** Whether the connected backend can block at all (the demo and signal-cli can). */
export function canBlock(app: AppServices): boolean {
  return app.requests.canBlock;
}

export interface BlockCopy {
  title: string;
  body: string;
  confirm: string;
  busy: string;
}

/** Signal Desktop's confirmation wording for blocking and unblocking a person or group. */
export function blockCopy(
  target: Pick<BlockTarget, 'group' | 'name'>,
  unblock: boolean,
): BlockCopy {
  if (unblock) {
    return {
      title: `Unblock ${target.name}?`,
      body: target.group
        ? 'Group members will be able to add you to this group again.'
        : 'You will be able to message and call each other.',
      confirm: 'Unblock',
      busy: 'Unblocking…',
    };
  }
  return target.group
    ? {
        title: `Block and Leave ${target.name}?`,
        body: "You will no longer receive messages or updates from this group and members won't be able to add you to this group again.",
        confirm: 'Block',
        busy: 'Blocking…',
      }
    : {
        title: `Block ${target.name}?`,
        body: "Blocked people won't be able to call you or send you messages.",
        confirm: 'Block',
        busy: 'Blocking…',
      };
}

/** The notice that stands where the composer would be, with Unblock beside it (Desktop's wording). */
export function blockedNotice(target: Pick<BlockTarget, 'group' | 'name'>): string {
  return target.group
    ? "Unblock this group and share your name and photo with its members? You won't receive any messages until you unblock them."
    : `Let ${target.name} message you and share your name and photo with them? You won't receive any messages until you unblock them.`;
}
