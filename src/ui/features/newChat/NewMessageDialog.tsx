import { LoaderCircle, Phone, AtSign, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { RecipientLookup } from '@/core/backend';
import {
  colorForId,
  initialsFor,
  type Contact,
  type RecipientQuery,
  type ConversationId,
} from '@/core/domain';
import { conversationFocusTarget, useSnowdrop } from '@/ui/hooks';
import { formatPhone, openDirectConversation, PersonAvatar } from '@/ui/features/conversation';
import { Kbd, Modal } from '@/ui/primitives';
import {
  CommandPalette,
  CommandPaletteGroup,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
  highlight,
} from '@/ui/primitives/CommandPalette';
import { composableContacts, searchNewMessage } from './model';
import styles from './NewMessageDialog.module.css';

type FailureKind = 'not-registered' | 'rate-limited' | 'failed';

/**
 * Shown for the person being looked up: `@username`, or the number. Only
 * NANP numbers are grouped (`formatPhone` guesses other countries' groups
 * wrongly); the rest read as plain E.164.
 */
const labelFor = (query: RecipientQuery): string =>
  query.kind === 'username'
    ? `@${query.username}`
    : query.e164.startsWith('+1')
      ? formatPhone(query.e164)
      : query.e164;

/** Signal Desktop's wording for a lookup that found nobody or failed. */
export function failureMessage(kind: FailureKind, query: RecipientQuery): string {
  if (kind === 'rate-limited') {
    return 'Too many lookups in a short time. Wait a little while, then try again.';
  }
  if (kind === 'not-registered') {
    return query.kind === 'phone'
      ? `User not found. “${labelFor(query)}” is not a Signal user.`
      : `${labelFor(query)} is not a Signal user. Make sure you’ve entered the complete username.`;
  }
  return `Failed to fetch ${query.kind === 'phone' ? 'phone number' : 'username'}. Check your connection and try again.`;
}

/**
 * New message: pick a contact, or find someone by phone number or username
 * (Signal Desktop's compose list, in Snowdrop's dialog). A found person opens
 * as a local, empty conversation; nothing is sent until the first message.
 */
export function NewMessageDialog({ onClose }: { onClose: () => void }) {
  const app = useSnowdrop();
  const { stores } = app;
  const contactsById = useStore(stores.contacts, (s) => s.byId);
  const self = useStore(stores.session, (s) => s.self);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  const [pending, setPending] = useState<RecipientQuery | null>(null);
  const [failure, setFailure] = useState<{ kind: FailureKind; query: RecipientQuery } | null>(null);
  /** Bumped when the text changes, a contact is chosen or the dialog closes: a late lookup result is dropped. */
  const generation = useRef(0);
  /** Where focus goes when the dialog closes: the composer of the opened conversation. */
  const target = useRef<(() => HTMLElement | null) | null>(null);
  const canLookup = app.backend.lookupRecipient !== undefined;

  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const contacts = useMemo(
    () => composableContacts(contactsById, self?.id ?? null),
    [contactsById, self?.id],
  );
  const search = useMemo(
    () => searchNewMessage(query, contacts, self?.number),
    [query, contacts, self?.number],
  );
  const find = canLookup ? search.find : null;
  /** Signal Desktop's "New group" sits at the top of the compose list, until you start searching. */
  const offerGroup = app.groups.available && query.trim() === '';

  const finish = (id: ConversationId) => {
    target.current = () => conversationFocusTarget(id, true);
    onClose();
  };

  const openContact = (contact: Contact) => {
    generation.current++;
    finish(openDirectConversation(app, contact));
  };

  const runLookup = async (recipient: RecipientQuery) => {
    if (pending) return;
    const mine = ++generation.current;
    setFailure(null);
    setPending(recipient);
    let outcome: RecipientLookup | null;
    try {
      outcome = (await app.backend.lookupRecipient?.(recipient)) ?? null;
    } catch {
      outcome = null;
    }
    if (mine !== generation.current) return;
    setPending(null);
    if (outcome?.status === 'found') {
      const known = stores.contacts.getState().byId[outcome.id];
      const contact: Contact = known ?? {
        id: outcome.id,
        name: outcome.name ?? labelFor(recipient),
        color: colorForId(outcome.id),
        ...(outcome.number ? { number: outcome.number } : {}),
      };
      if (!known) stores.contacts.getState().upsert(contact);
      finish(openDirectConversation(app, contact));
    } else {
      setFailure({ kind: outcome?.status ?? 'failed', query: recipient });
    }
  };

  const text = query.trim();
  const empty =
    search.contacts.length > 0 || find || offerGroup
      ? undefined
      : text === ''
        ? canLookup
          ? 'No contacts yet. Enter a phone number or a username to start a chat.'
          : 'No contacts yet.'
        : canLookup && search.needsCountryCode
          ? 'To look up a number, include its country code, like +1 202 555 0123.'
          : `No contacts match “${text}”.`;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="New message"
      description={
        canLookup
          ? 'Choose a contact, or enter a phone number or a username like name.123 to find someone new.'
          : 'Choose a contact.'
      }
      placement="top"
      size="lg"
      flush
      className={styles.modal}
      returnFocus={() => target.current?.() ?? null}
      footer={
        <div className={styles.hints}>
          <span>
            <Kbd combo="↑" />
            <Kbd combo="↓" /> move
          </span>
          <span>
            <Kbd combo="Enter" /> open
          </span>
          <span>
            <Kbd combo="Esc" /> close
          </span>
        </div>
      }
    >
      <CommandPalette label="Name, username or number" value={active} onValueChange={setActive}>
        <CommandPaletteInput
          data-autofocus
          value={query}
          onValueChange={(value) => {
            generation.current++;
            setPending(null);
            setFailure(null);
            setQuery(value);
          }}
          placeholder="Name, username, or number"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className={styles.notice} role="status" data-busy={pending ? '' : undefined}>
          {pending && (
            <>
              <LoaderCircle size={16} className={styles.spin} aria-hidden />
              <span>Looking up {labelFor(pending)}…</span>
            </>
          )}
        </div>
        <div className={styles.notice} role="alert" data-error="">
          {failure && failureMessage(failure.kind, failure.query)}
        </div>
        <CommandPaletteList label="People" empty={empty}>
          {offerGroup && (
            <CommandPaletteGroup heading="Group">
              <CommandPaletteItem
                key="new-group"
                value="new-group"
                onSelect={() => {
                  // Replaces this dialog: the group dialog takes over the same layer.
                  stores.ui.getState().openModal({ type: 'newGroup' });
                }}
                icon={<UsersRound size={18} />}
              >
                New group
              </CommandPaletteItem>
            </CommandPaletteGroup>
          )}
          {find && (
            <CommandPaletteGroup
              heading={find.kind === 'phone' ? 'Find by phone number' : 'Find by username'}
            >
              <CommandPaletteItem
                key={`find:${find.kind}`}
                value={`find:${find.kind}`}
                disabled={pending !== null}
                onSelect={() => {
                  void runLookup(find);
                }}
                icon={find.kind === 'phone' ? <Phone size={18} /> : <AtSign size={18} />}
                meta={
                  pending ? <LoaderCircle size={16} className={styles.spin} aria-hidden /> : null
                }
              >
                {labelFor(find)}
              </CommandPaletteItem>
            </CommandPaletteGroup>
          )}
          {search.contacts.length > 0 && (
            <CommandPaletteGroup heading="Contacts">
              {search.contacts.map(({ contact, indices }) => (
                <CommandPaletteItem
                  key={contact.id}
                  value={`contact:${contact.id}`}
                  onSelect={() => {
                    openContact(contact);
                  }}
                  icon={
                    <PersonAvatar
                      size={24}
                      contactId={contact.id}
                      fallback={initialsFor(contact.name).slice(0, 2)}
                      color={contact.color}
                    />
                  }
                  meta={contact.number ? formatPhone(contact.number) : null}
                >
                  {highlight(contact.name, indices)}
                </CommandPaletteItem>
              ))}
            </CommandPaletteGroup>
          )}
        </CommandPaletteList>
      </CommandPalette>
    </Modal>
  );
}
