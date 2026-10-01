import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { fuzzyFilter, type Contact, type ConversationView } from '@/core/domain';
import { contactsSelectors, sessionSelectors } from '@/core/stores';
import { useHearth, useObservableList } from '@/ui/hooks';
import { loadEmojiIndex, searchEmoji, type EmojiEntry } from './emojiIndex';
import type { MentionToken } from './mentionTokens';
import { findTrigger, type Trigger } from './triggers';

export type Suggestion =
  | { kind: 'mention'; key: string; contact: Contact; insert: string; token: MentionToken }
  | { kind: 'emoji'; key: string; emoji: string; code: string; insert: string }
  | {
      kind: 'slash';
      key: string;
      name: string;
      usage?: string;
      description: string;
      owner: string;
      insert: string;
    };

const LIMIT = 8;

export interface Autocomplete {
  trigger: Trigger | null;
  suggestions: Suggestion[];
  open: boolean;
  active: number;
  setActive: (index: number) => void;
  move: (delta: number) => void;
  dismiss: () => void;
}

/** Suggestions for the trigger at the caret: members, `:emoji:` or `/commands`. */
export function useAutocomplete(
  text: string,
  caret: number,
  conversation: ConversationView,
): Autocomplete {
  const { stores, registries } = useHearth();
  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const commands = useObservableList(registries.slash);
  const [emojiIndex, setEmojiIndex] = useState<readonly EmojiEntry[] | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeState, setActiveState] = useState({ key: '', index: 0 });

  const trigger = useMemo(() => findTrigger(text, caret), [text, caret]);
  const wantsEmoji = trigger?.kind === 'emoji';
  // A dismissal lasts until the trigger goes away (typing on keeps it closed).
  if (!trigger && dismissedAt !== null) setDismissedAt(null);

  useEffect(() => {
    if (!wantsEmoji || emojiIndex) return;
    let cancelled = false;
    loadEmojiIndex()
      .then((index) => {
        if (!cancelled) setEmojiIndex(index);
      })
      .catch((error: unknown) => {
        console.warn('[hearth] emoji shortcodes unavailable', error);
      });
    return () => {
      cancelled = true;
    };
  }, [wantsEmoji, emojiIndex]);

  const suggestions = useMemo((): Suggestion[] => {
    if (!trigger) return [];
    if (trigger.kind === 'mention') {
      const people = conversation.memberIds
        .filter((id) => id !== selfId)
        .flatMap((id) => (contacts[id] ? [contacts[id]] : []));
      const ranked =
        trigger.query === ''
          ? people
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((contact) => ({ item: contact }))
          : fuzzyFilter(trigger.query, people, (c) => c.name);
      return ranked.slice(0, LIMIT).map(({ item: contact }) => {
        const label = `@${contact.name}`;
        return {
          kind: 'mention',
          key: `m-${contact.id}`,
          contact,
          insert: `${label} `,
          token: { id: contact.id, label },
        };
      });
    }
    if (trigger.kind === 'emoji') {
      if (!emojiIndex) return [];
      return searchEmoji(emojiIndex, trigger.query, LIMIT).map(({ entry, code }) => ({
        kind: 'emoji',
        key: `e-${code}`,
        emoji: entry.emoji,
        code,
        insert: entry.emoji,
      }));
    }
    const q = trigger.query.toLowerCase();
    return commands
      .filter((c) => c.name.startsWith(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, LIMIT)
      .map((c) => ({
        kind: 'slash',
        key: `s-${c.owner}-${c.name}`,
        name: c.name,
        ...(c.usage ? { usage: c.usage } : {}),
        description: c.description,
        owner: c.owner,
        insert: `/${c.name} `,
      }));
  }, [trigger, conversation.memberIds, selfId, contacts, emojiIndex, commands]);

  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : '';
  const active =
    activeState.key === triggerKey
      ? Math.min(activeState.index, Math.max(0, suggestions.length - 1))
      : 0;
  const open = trigger !== null && suggestions.length > 0 && dismissedAt !== trigger.start;

  return {
    trigger,
    suggestions,
    open,
    active,
    setActive: (index) => {
      setActiveState({ key: triggerKey, index });
    },
    move: (delta) => {
      const n = suggestions.length;
      if (n === 0) return;
      setActiveState({ key: triggerKey, index: (active + delta + n) % n });
    },
    dismiss: () => {
      if (trigger) setDismissedAt(trigger.start);
    },
  };
}
