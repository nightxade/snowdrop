import { ArrowLeft, LoaderCircle, Send } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { isMacPlatform } from '@/core/commands';
import {
  composableContacts,
  initialsFor,
  isForwardable,
  MAX_FORWARD_TARGETS,
  messageRequestState,
  type ConversationId,
  type MessageId,
} from '@/core/domain';
import { selectConversationViews, sessionSelectors, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { conversationFocusTarget, useSnowdrop } from '@/ui/hooks';
import { ConversationAvatar, formatPhone, PersonAvatar } from '@/ui/features/conversation';
import { Button, Kbd, Modal, VisuallyHidden } from '@/ui/primitives';
import {
  CommandPalette,
  CommandPaletteGroup,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
  highlight,
} from '@/ui/primitives/CommandPalette';
import { ForwardPreview } from './ForwardPreview';
import { readPreviewImage, useForwardMedia } from './media';
import {
  buildForwardTargets,
  draftHasContent,
  draftOf,
  previewStillApplies,
  searchForwardTargets,
  type ForwardDraft,
  type ForwardFileRef,
  type ForwardTarget,
  type TargetMatch,
} from './model';
import { forwardToTargets, type ForwardItem } from './send';
import styles from './forward.module.css';

export interface ForwardDialogProps {
  /** The conversation the messages are in. */
  conversationId: ConversationId;
  messageIds: readonly MessageId[];
  onClose: () => void;
}

interface Failure {
  /** How many chats it did go to. */
  sent: number;
  failed: { id: ConversationId; title: string; reason: string }[];
}

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** "Mira", "Mira and Jon", "Mira, Jon and 1 more". */
function nameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/**
 * Forward to: pick up to five chats (search by name or number, Enter picks,
 * ↑/↓ move), then send. A single message that can be changed (Signal
 * Desktop's rule: not a sticker or a voice message) goes through a second step
 * first, where its text can be edited and files or the link preview taken out.
 * Received files are fetched before anything is sent, with the reason shown for
 * one that can't be. Each chat gets its own ordinary send, so it appears there
 * with a normal pending / failed state and Retry.
 */
export function ForwardDialog({ conversationId, messageIds, onClose }: ForwardDialogProps) {
  const app = useSnowdrop();
  const { stores } = app;
  const contactsById = useStore(stores.contacts, (s) => s.byId);
  const byId = useStore(stores.conversations, (s) => s.byId);
  const local = useStore(stores.local, (s) => s.conversations);
  const acceptedChats = useStore(stores.local, (s) => s.acceptedChats);
  const self = useStore(stores.session, sessionSelectors.self);
  const selfId = self?.id ?? null;

  const [drafts, setDrafts] = useState<ForwardDraft[]>(() => {
    const window = stores.messages.getState().windows[conversationId];
    const contacts = stores.contacts.getState().byId;
    const names = (id: string) => contacts[id]?.name ?? UNKNOWN_CONTACT_NAME;
    return messageIds
      .flatMap((id) => {
        const m = window?.byId[id];
        return m && isForwardable(m) ? [draftOf(m, names)] : [];
      })
      .sort((a, b) => a.order - b.order);
  });
  const nameFor = (id: string) => contactsById[id]?.name ?? UNKNOWN_CONTACT_NAME;
  const lonely = drafts.length === 1 ? drafts[0] : undefined;

  const [phase, setPhase] = useState<'pick' | 'edit'>('pick');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  const [selected, setSelected] = useState<ConversationId[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const alive = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editorId = useId();
  const media = useForwardMedia(conversationId, drafts);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Nothing left to forward (the messages are gone): nothing to show.
  const empty = drafts.length === 0;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
  // Moving between the steps takes the keyboard to the new step's own field.
  const entered = useRef(false);
  useEffect(() => {
    if (!entered.current) {
      entered.current = true;
      return;
    }
    if (phase === 'edit') {
      const field = editorRef.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    } else searchRef.current?.focus();
  }, [phase]);

  const targets = useMemo(
    () =>
      buildForwardTargets({
        views: selectConversationViews(byId, local),
        contacts: contactsById,
        composable: composableContacts(contactsById, selfId),
        self,
        requestState: (view) =>
          messageRequestState(view, {
            selfId,
            contact: (id) => contactsById[id],
            acceptedHere: acceptedChats[view.id] !== undefined,
          }),
      }),
    [byId, local, contactsById, acceptedChats, selfId, self],
  );
  const matches = useMemo(() => searchForwardTargets(query, targets), [query, targets]);
  const picked = selected.flatMap((id) => targets.find((t) => t.id === id) ?? []);
  const searching = query.trim() !== '';

  const states = drafts.flatMap((d) => d.files.map((f) => media.stateOf(d, f)));
  const waiting = states.some((s) => s.status === 'loading' || s.status === 'backfilling');
  const broken = states.some((s) => s.status === 'error');
  const complete = drafts.every(draftHasContent);
  const ready = !waiting && !broken && complete;
  /** The primary button goes on to the editor (a message that can change) rather than sending. */
  const goesOn = phase === 'pick' && lonely?.editable === true;
  const canPrimary = selected.length > 0 && !sending && (goesOn || ready);

  const toggle = (target: ForwardTarget) => {
    setFailure(null);
    if (target.unavailable) {
      setNotice(`${target.title}: ${target.unavailable}.`);
    } else if (selected.includes(target.id)) {
      setNotice(null);
      setSelected(selected.filter((id) => id !== target.id));
    } else if (selected.length >= MAX_FORWARD_TARGETS) {
      setNotice(`You can forward to ${MAX_FORWARD_TARGETS} chats at most.`);
    } else {
      setNotice(null);
      setSelected([...selected, target.id]);
    }
  };

  const editDraft = (draft: ForwardDraft, patch: Partial<ForwardDraft>) => {
    setDrafts((current) =>
      current.map((d) => (d.messageId === draft.messageId ? { ...d, ...patch } : d)),
    );
  };
  const removeFile = (draft: ForwardDraft, file: ForwardFileRef) => {
    editDraft(draft, { files: draft.files.filter((f) => f.key !== file.key) });
  };
  const removePreview = (draft: ForwardDraft) => {
    const { preview: _gone, ...rest } = draft;
    setDrafts((current) => current.map((d) => (d.messageId === draft.messageId ? rest : d)));
  };

  /** What goes out, with every file's bytes in hand. */
  const itemsToSend = async (): Promise<ForwardItem[]> => {
    const items: ForwardItem[] = [];
    for (const draft of drafts) {
      if (draft.sticker) {
        items.push({ kind: 'sticker', sticker: draft.sticker });
        continue;
      }
      const files = draft.files.flatMap((file) => {
        const state = media.stateOf(draft, file);
        return state.status === 'ready'
          ? [
              {
                fileName: file.fileName,
                contentType: file.contentType,
                data: state.blob,
                ...(file.width !== undefined ? { width: file.width } : {}),
                ...(file.height !== undefined ? { height: file.height } : {}),
                ...(file.voiceNote ? { voiceNote: true } : {}),
              },
            ]
          : [];
      });
      const link = draft.preview && previewStillApplies(draft) ? draft.preview : undefined;
      const picture = link?.image;
      const bytes = picture ? await readPreviewImage(app, conversationId, picture) : null;
      items.push({
        kind: 'message',
        text: draft.text,
        files,
        ...(link
          ? {
              preview: {
                url: link.url,
                title: link.title ?? link.url,
                ...(link.description ? { description: link.description } : {}),
                ...(picture && bytes
                  ? {
                      image: {
                        contentType: picture.contentType,
                        data: bytes,
                        ...(picture.width !== undefined ? { width: picture.width } : {}),
                        ...(picture.height !== undefined ? { height: picture.height } : {}),
                      },
                    }
                  : {}),
              },
            }
          : {}),
      });
    }
    return items;
  };

  const send = async () => {
    if (sending || selected.length === 0 || !ready) return;
    setSending(true);
    setFailure(null);
    const results = await forwardToTargets(app, picked, await itemsToSend());
    const failed = results.flatMap((r) =>
      r.ok
        ? []
        : [{ id: r.id, title: targets.find((t) => t.id === r.id)?.title ?? '', reason: r.reason }],
    );
    const ui = stores.ui.getState();
    if (failed.length === 0) {
      ui.pushToast({
        message:
          picked.length === 1
            ? `Forwarded to ${picked[0]?.title ?? 'the chat'}`
            : `Forwarded to ${picked.length} chats`,
        kind: 'success',
        source: 'core',
      });
      if (alive.current) onClose();
    } else if (alive.current) {
      // What went through stays sent; the rest stays picked, ready to try again.
      setSelected(selected.filter((id) => failed.some((f) => f.id === id)));
      setFailure({ sent: results.length - failed.length, failed });
      setSending(false);
    } else {
      // The dialog was closed while this ran: say so where the user is looking now.
      ui.pushToast({
        message: `Couldn't forward to ${plural(failed.length, 'chat', 'chats')}`,
        kind: 'error',
        source: 'core',
      });
    }
  };

  const primary = () => {
    if (goesOn) setPhase('edit');
    else void send();
  };

  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    // Before the list's own Enter, which would pick the highlighted chat.
    e.preventDefault();
    e.stopPropagation();
    if (canPrimary) primary();
  };

  if (empty) return null;

  const row = ({ target, indices }: TargetMatch) => (
    <CommandPaletteItem
      key={target.id}
      value={target.id}
      checked={selected.includes(target.id)}
      onSelect={() => {
        toggle(target);
      }}
      icon={
        target.view ? (
          <ConversationAvatar conversation={target.view} size={24} />
        ) : (
          <PersonAvatar
            size={24}
            contactId={target.contact?.id ?? target.id}
            fallback={initialsFor(target.title).slice(0, 2)}
            color={target.contact?.color ?? 'var(--snowdrop-avatar-1)'}
          />
        )
      }
      meta={
        <span data-unavailable={target.unavailable ? '' : undefined}>
          {[
            target.unavailable ?? target.meta,
            target.number && !target.unavailable && target.kind === 'direct'
              ? formatPhone(target.number)
              : null,
            target.request ? 'Message request' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      }
    >
      {highlight(target.title, indices)}
    </CommandPaletteItem>
  );

  const recent = matches.filter((m) => m.target.view !== undefined);
  const contacts = matches.filter((m) => m.target.view === undefined);
  const emptyText =
    matches.length > 0
      ? undefined
      : searching
        ? `No chats match “${query.trim()}”.`
        : 'No chats to forward to yet.';

  const failureAlert = (
    <div className={styles.notice} role="alert" data-error="">
      {failure &&
        `${failure.sent > 0 ? `Sent to ${plural(failure.sent, 'chat', 'chats')}. ` : ''}Couldn't send to ${nameList(failure.failed.map((f) => f.title))}: ${failure.failed[0]?.reason ?? ''}`}
    </div>
  );

  const names = nameList(picked.map((t) => t.title));
  let hint: string | null = null;
  if (!goesOn && waiting) hint = 'Waiting for the attachments to download.';
  else if (broken) hint = 'Remove the attachment that couldn’t be downloaded to go on.';
  else if (!goesOn && !complete) hint = 'There is nothing left to send.';
  else if (picked.some((t) => t.request)) hint = 'Forwarding to a message request accepts it.';
  const combo = isMacPlatform() ? '⌘↩' : 'Ctrl+Enter';

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Forward to"
      description={
        phase === 'pick'
          ? `Choose up to ${MAX_FORWARD_TARGETS} chats to forward to.`
          : `Review the message, then send it to ${names}.`
      }
      placement="top"
      size="lg"
      flush
      className={styles.modal}
      returnFocus={() => {
        const first = messageIds[0];
        const row = first
          ? document.querySelector<HTMLElement>(
              `[data-snowdrop="message-log"] [data-message-id="${CSS.escape(first)}"]`,
            )
          : null;
        return row ?? conversationFocusTarget(conversationId);
      }}
      footer={
        <div className={styles.footer}>
          <div className={styles.summary}>
            <span className={styles.names} aria-live="polite">
              {picked.length > 0 ? names : `Choose up to ${MAX_FORWARD_TARGETS} chats`}
              {picked.length > 0 && (
                <VisuallyHidden>{` (${picked.length} of ${MAX_FORWARD_TARGETS} chosen)`}</VisuallyHidden>
              )}
            </span>
            {hint ? (
              <span className={styles.hint}>{hint}</span>
            ) : (
              <span className={styles.keys}>
                <Kbd combo={combo} /> {goesOn ? 'next' : 'send'}
              </span>
            )}
          </div>
          <div className={styles.actions}>
            {phase === 'edit' ? (
              <Button
                variant="ghost"
                icon={<ArrowLeft size={16} />}
                disabled={sending}
                onClick={() => {
                  setPhase('pick');
                }}
              >
                Back
              </Button>
            ) : (
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!canPrimary}
              icon={
                sending ? (
                  <LoaderCircle size={16} className={styles.spin} />
                ) : goesOn ? undefined : (
                  <Send size={16} />
                )
              }
              onClick={primary}
            >
              {sending ? 'Sending…' : goesOn ? 'Next' : 'Send'}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.content} onKeyDownCapture={onKeyDownCapture}>
        {phase === 'pick' ? (
          <>
            <ForwardPreview
              drafts={drafts}
              media={media}
              nameFor={nameFor}
              showText
              disabled={sending}
              onRemoveFile={removeFile}
              onRemovePreview={removePreview}
            />
            <CommandPalette label="Chats to forward to" value={active} onValueChange={setActive}>
              <CommandPaletteInput
                ref={searchRef}
                data-autofocus
                value={query}
                onValueChange={(value) => {
                  setQuery(value);
                  setNotice(null);
                }}
                placeholder="Search chats and contacts"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <div className={styles.notice} role="status">
                {notice}
              </div>
              {failureAlert}
              <CommandPaletteList label="Chats" empty={emptyText} multiselectable>
                {searching ? (
                  <CommandPaletteGroup>{matches.map(row)}</CommandPaletteGroup>
                ) : (
                  <>
                    {recent.length > 0 && (
                      <CommandPaletteGroup heading="Recent chats">
                        {recent.map(row)}
                      </CommandPaletteGroup>
                    )}
                    {contacts.length > 0 && (
                      <CommandPaletteGroup heading="Contacts">
                        {contacts.map(row)}
                      </CommandPaletteGroup>
                    )}
                  </>
                )}
              </CommandPaletteList>
            </CommandPalette>
          </>
        ) : (
          lonely && (
            <div className={styles.editor}>
              <label className={styles.label} htmlFor={editorId}>
                Message
              </label>
              <textarea
                id={editorId}
                ref={editorRef}
                data-autofocus
                className={styles.textarea}
                rows={5}
                value={lonely.text}
                disabled={sending}
                onChange={(e) => {
                  editDraft(lonely, { text: e.target.value });
                  setFailure(null);
                }}
              />
              <ForwardPreview
                drafts={drafts}
                media={media}
                nameFor={nameFor}
                showText={false}
                disabled={sending}
                onRemoveFile={removeFile}
                onRemovePreview={removePreview}
              />
              {failureAlert}
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
