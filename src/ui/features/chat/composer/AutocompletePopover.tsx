import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react';
import { Slash } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { initialsFor, type ConversationId } from '@/core/domain';
import { PersonAvatar } from '@/ui/features/conversation';
import { optionId } from './optionId';
import type { Suggestion } from './useAutocomplete';
import type { TriggerKind } from './triggers';
import styles from './AutocompletePopover.module.css';

const TITLES: Record<TriggerKind, string> = {
  mention: 'Members',
  emoji: 'Emoji matching',
  slash: 'Commands',
};

export interface AutocompletePopoverProps {
  id: string;
  anchor: HTMLElement | null;
  kind: TriggerKind;
  query: string;
  suggestions: readonly Suggestion[];
  active: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
  /** The conversation being written in (a stranger's photo stays hidden until it's accepted). */
  conversationId?: ConversationId | undefined;
}

/** Suggestion list floating above the composer (a listbox the textarea controls). */
export function AutocompletePopover({
  id,
  anchor,
  kind,
  query,
  suggestions,
  active,
  onHover,
  onPick,
  conversationId,
}: AutocompletePopoverProps) {
  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: 'top-start',
    strategy: 'fixed',
    elements: { reference: anchor },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ rects, elements, availableHeight }) {
          Object.assign(elements.floating.style, {
            width: `${rects.reference.width}px`,
            maxHeight: `${Math.min(360, availableHeight)}px`,
          });
        },
      }),
    ],
  });
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <FloatingPortal>
      <div
        ref={(el) => {
          refs.setFloating(el);
          list.current = el;
        }}
        style={floatingStyles}
        className={styles.popover}
        data-snowdrop="autocomplete"
        // Portalled to <body>: a labelled region keeps it inside a landmark.
        role="region"
        aria-label="Suggestions"
      >
        <div className={styles.title} aria-hidden>
          {TITLES[kind]}
          {kind === 'emoji' && <span className={styles.query}> :{query}</span>}
        </div>
        <div id={id} role="listbox" aria-label={TITLES[kind]} className={styles.list}>
          {suggestions.map((s, i) => (
            <div
              key={s.key}
              id={optionId(id, i)}
              role="option"
              aria-selected={i === active}
              data-index={i}
              className={styles.option}
              onPointerMove={() => {
                if (i !== active) onHover(i);
              }}
              onPointerDown={(e) => {
                // Keep focus (and the caret) in the textarea.
                e.preventDefault();
                onPick(i);
              }}
            >
              <SuggestionRow suggestion={s} conversationId={conversationId} />
            </div>
          ))}
        </div>
        <div className={styles.footer} aria-hidden>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to navigate · <kbd>Tab</kbd> or <kbd>Enter</kbd> to pick · <kbd>Esc</kbd> to
          dismiss
        </div>
      </div>
    </FloatingPortal>
  );
}

function SuggestionRow({
  suggestion: s,
  conversationId,
}: {
  suggestion: Suggestion;
  conversationId: ConversationId | undefined;
}) {
  if (s.kind === 'mention') {
    return (
      <>
        <PersonAvatar
          size={24}
          contactId={s.contact.id}
          conversationId={conversationId}
          fallback={initialsFor(s.contact.name)}
          color={s.contact.color}
        />
        <span className={styles.primary}>{s.contact.name}</span>
        {s.contact.profileName && s.contact.profileName !== s.contact.name && (
          <span className={styles.secondary}>{s.contact.profileName}</span>
        )}
      </>
    );
  }
  if (s.kind === 'emoji') {
    return (
      <>
        <span className={styles.emoji}>{s.emoji}</span>
        <span className={styles.primary}>:{s.code}:</span>
      </>
    );
  }
  if (s.kind === 'customEmoji') {
    if (s.emojiKind === 'image')
      return (
        <>
          <img className={styles.customEmoji} src={s.dataUrl} alt="" />
          <span className={styles.primary}>:{s.name}:</span>
        </>
      );
    return (
      <>
        <span className={styles.customEmojiText}>{s.text}</span>
        <span className={styles.owner}>:{s.name}:</span>
      </>
    );
  }
  return (
    <>
      <span className={styles.slashIcon}>
        <Slash size={14} aria-hidden />
      </span>
      <span className={styles.primary}>
        /{s.name}
        {s.usage && <span className={styles.usage}> {s.usage}</span>}
      </span>
      <span className={styles.secondary}>{s.description}</span>
      {s.owner !== 'core' && <span className={styles.owner}>{s.owner}</span>}
    </>
  );
}
