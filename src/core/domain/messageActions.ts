/**
 * What the user may do with one message: the single place every surface that
 * offers an action (keyboard and command layers, the context menu, the hover
 * bar, poll cards) asks, so they cannot disagree. Pure: it reads only what it
 * is handed.
 */
import { isForwardable } from './forward';
import { canSendToGroup } from './groups';
import { isPendingMessageId } from './ids';
import { canEditMessage, isWithinDeleteWindow } from './editing';
import type { Conversation, Message } from './types';

export interface MessagePermissions {
  own: boolean;
  failed: boolean;
  pending: boolean;
  /** The chat has a composer to answer in (accepted, and the user may write there). */
  canCompose: boolean;
  /** Reply fills the composer's quote, so it needs one (not a request, blocked or read-only chat). */
  canReply: boolean;
  canEdit: boolean;
  canReact: boolean;
  /** Forwarding needs the message's files, so (like reacting) not before the chat is accepted. */
  canForward: boolean;
  /** There is text to copy. */
  canCopy: boolean;
  /** Delete for me: any message that has gone out (an unsent one is discarded instead). */
  canDelete: boolean;
  /** Our own message, still inside the 24 hour window, and not note-to-self; otherwise delete is for me only. */
  canDeleteForEveryone: boolean;
  canAdminDelete: boolean;
  canPin: boolean;
  /** Message details (read/delivered receipts): own, sent messages. */
  canShowDetails: boolean;
  /** A poll that is open, sent, and one the user may answer. */
  canVotePoll: boolean;
  /** One of the user's own polls that is open and sent. */
  canEndPoll: boolean;
}

export interface MessageActionFacts {
  selfId: string | null;
  conversation:
    | (Pick<Conversation, 'id' | 'kind' | 'adminIds' | 'memberIds'> &
        Partial<Pick<Conversation, 'left' | 'permissions'>>)
    | undefined;
  /** The conversation is accepted (not a message request, not blocked). */
  accepted: boolean;
  capabilities: { pin: boolean; adminDelete: boolean; polls: boolean };
  /** Epoch ms; edit limits depend on it. */
  now: number;
}

/** How a failed send's retry is worded, everywhere it is offered. */
export interface RetryCopy {
  /** What the failed row says. */
  status: string;
  /** The short button beside the status. */
  button: string;
  /** The menu / toolbar label (it carries the warning when there is one). */
  menuLabel: string;
  /** Said when sending again could deliver the message twice. */
  warning?: string;
}

/**
 * A send that timed out may have gone out, so its retry is "Send again" with a
 * warning (`Message.sendUnconfirmed`); any other failure is a plain retry.
 */
export function retryCopy(m: Pick<Message, 'sendUnconfirmed'>): RetryCopy {
  if (m.sendUnconfirmed) {
    return {
      status: 'May have sent',
      button: 'Send again',
      menuLabel: 'Send again (may have sent)',
      warning:
        'No answer came back, so it may have been sent. Sending again could deliver it twice.',
    };
  }
  return { status: 'Failed to send', button: 'Retry', menuLabel: 'Retry sending' };
}

export function messagePermissions(m: Message, facts: MessageActionFacts): MessagePermissions {
  const { selfId, conversation, accepted, capabilities: caps } = facts;
  const own = selfId !== null && m.authorId === selfId;
  const failed = m.status === 'failed' && own;
  const pending = isPendingMessageId(m.id);
  const admin = selfId !== null && (conversation?.adminIds.includes(selfId) ?? false);
  const normal = m.kind === 'normal' && !m.deleted;
  const deletable = isWithinDeleteWindow(m, facts.now, selfId);
  const canCompose = accepted && canSendToGroup(conversation, selfId);
  // Answering or ending a poll needs it to exist for everyone already: unsent and failed ones can't be.
  const openPoll = normal && m.poll !== undefined && m.poll.ended !== true && !pending && !failed;
  return {
    own,
    failed,
    pending,
    canCompose,
    canReply: normal && !failed && canCompose,
    canEdit: canEditMessage(m, { selfId, now: facts.now }),
    // Reacting and pinning send something to the other side: not before the
    // user has accepted them (a message request is read-only).
    canReact: normal && !failed && accepted,
    canForward: accepted && isForwardable(m),
    canCopy: normal && m.body !== '',
    canDelete: !failed,
    canDeleteForEveryone: own && normal && deletable,
    canAdminDelete:
      normal && !own && admin && conversation?.kind === 'group' && caps.adminDelete && deletable,
    canPin: normal && !failed && accepted && caps.pin,
    canShowDetails: own && !failed && normal,
    canVotePoll: openPoll && accepted && caps.polls,
    canEndPoll: openPoll && own && caps.polls,
  };
}
