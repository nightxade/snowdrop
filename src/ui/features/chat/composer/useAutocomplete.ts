import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { fuzzyFilter, type Contact } from '@/core/domain';
import { createLogger } from '@/core/lib';
import { contactsSelectors, sessionSelectors } from '@/core/stores';
import { useSnowdrop, useObservableList } from '@/ui/hooks';
import { loadEmojiIndex, searchEmoji, type EmojiEntry } from './emojiIndex';
import type { MentionToken } from './mentionTokens';
import { findTrigger, type Trigger } from './triggers';

const log = createLogger('ui');

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
  memberIds: readonly string[],
  /** Offer /commands (composer only). */
  slash = true,
  /** False suspends suggestions (Vim mode outside Insert mode). */
  enabled = true,
): Autocomplete {
  const { stores, registries, plugins } = useSnowdrop();
  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const commands = useObservableList(registries.slash);
  const [emojiIndex, setEmojiIndex] = useState<readonly EmojiEntry[] | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeState, setActiveState] = useState({ key: '', index: 0 });

  const found = useMemo(() => findTrigger(text, caret), [text, caret]);
  const trigger = !enabled || (found?.kind === 'slash' && !slash) ? null : found;
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
        log.warn('emoji shortcodes unavailable', error);
      });
    return () => {
      cancelled = true;
    };
  }, [wantsEmoji, emojiIndex]);

  const suggestions = useMemo((): Suggestion[] => {
    if (!trigger) return [];
    if (trigger.kind === 'mention') {
      const people = memberIds
        .filter((id) => id !== selfId)
        .flatMap((id) => (contacts[id] ? [contacts[id]] : []));
      // Two members with one display name get distinguishable labels, so the
      // mention resolves to the person who was picked.
      const nameCounts = new Map<string, number>();
      for (const p of people) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
      const labelFor = (c: Contact) =>
        (nameCounts.get(c.name) ?? 0) > 1
          ? `@${c.name} (${c.profileName && c.profileName !== c.name ? c.profileName : (c.number ?? c.id).slice(-4)})`
          : `@${c.name}`;
      const ranked =
        trigger.query === ''
          ? people
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((contact) => ({ item: contact }))
          : fuzzyFilter(trigger.query, people, (c) => c.name);
      return ranked.slice(0, LIMIT).map(({ item: contact }) => {
        const label = labelFor(contact);
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
        // Without the trailing presentation selector some data adds, plus a space to keep typing.
        insert: `${withoutExtraSelector(entry.emoji)} `,
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
        // Shown as attribution: the plugin's name, not its id.
        owner: c.owner === 'core' ? 'core' : (plugins.get(c.owner)?.definition.name ?? c.owner),
        insert: `/${c.name} `,
      }));
  }, [trigger, memberIds, selfId, contacts, emojiIndex, commands, plugins]);

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

/**
 * Drops a trailing U+FE0F after characters that are emoji by default (the
 * data adds it to e.g. 👍, where it only makes reactions and text compare
 * unequal); keeps it where it matters (❤️ would otherwise render as text).
 */
export function withoutExtraSelector(emoji: string): string {
  if (!emoji.endsWith('\uFE0F')) return emoji;
  const base = emoji.slice(0, -1);
  const tail = base.charCodeAt(base.length - 1);
  const lowSurrogate = tail >= 0xdc00 && tail <= 0xdfff;
  const last = base.codePointAt(base.length - (lowSurrogate ? 2 : 1));
  return last !== undefined && last >= 0x1f000 ? base : emoji;
}
