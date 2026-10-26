import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ConversationId } from '@/core/domain';
import { optionId } from './optionId';
import { wrapSelection } from './formatting';
import type { MentionToken } from './mentionTokens';
import { useAutocomplete } from './useAutocomplete';
import { replaceRange } from './useAutoGrow';

// The popover (with floating-ui) is its own chunk, fetched when a field first mounts and
// the browser is idle, so the first "@" never waits on the network.
const loadPopover = () => import('./AutocompletePopover');
const AutocompletePopover = lazy(() =>
  loadPopover().then((m) => ({ default: m.AutocompletePopover })),
);

function usePrefetchPopover(): void {
  useEffect(() => {
    const prefetch = () => {
      void loadPopover();
    };
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(prefetch);
      return () => {
        window.cancelIdleCallback(handle);
      };
    }
    const timer = setTimeout(prefetch, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, []);
}

export interface AutocompleteFieldOptions {
  textarea: RefObject<HTMLTextAreaElement | null>;
  /** Element the suggestions float above (usually the field's frame). */
  anchor: HTMLElement | null;
  text: string;
  setText: (text: string) => void;
  memberIds: readonly string[];
  /** Passed on to the suggestions' avatars. */
  conversationId?: ConversationId;
  onMention: (token: MentionToken) => void;
  /** Slash commands only make sense in the composer, not the inline editor. */
  slash: boolean;
  /** False suspends suggestions (Vim mode outside Insert mode); default true. */
  suggestions?: boolean;
}

export interface AutocompleteField {
  /** Handles autocomplete navigation and formatting shortcuts; true if the key was consumed. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Keep the trigger in sync with the caret (onChange / onSelect). */
  syncCaret: () => void;
  /** Replace a range through the editing pipeline (keeps native undo). */
  replace: (start: number, end: number, insert: string, selStart?: number, selEnd?: number) => void;
  /** aria-* props for the textarea. */
  inputProps: {
    'aria-autocomplete': 'list';
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
  };
  popover: ReactNode;
}

/** IME composition (including the keyCode 229 some browsers report instead of isComposing). */
export function isImeKey(e: KeyboardEvent): boolean {
  // keyCode is deprecated, but it is the only signal some IMEs give (Safari, older Chrome on Android).
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * Shared by the composer and the inline editor: @member / :emoji: (and,
 * for the composer, /command) suggestions, arrow/Tab/Enter/Escape handling,
 * and the Ctrl/Cmd+B/I/Shift+X formatting shortcuts.
 */
export function useAutocompleteField(o: AutocompleteFieldOptions): AutocompleteField {
  const [caret, setCaret] = useState(o.text.length);
  const listId = useId();
  usePrefetchPopover();
  const auto = useAutocomplete(o.text, caret, o.memberIds, o.slash, o.suggestions ?? true);

  const syncCaret = () => {
    const el = o.textarea.current;
    if (el) setCaret(el.selectionEnd);
  };
  const replace = (
    start: number,
    end: number,
    insert: string,
    selStart?: number,
    selEnd?: number,
  ) => {
    const el = o.textarea.current;
    if (!el) return;
    o.setText(replaceRange(el, start, end, insert, selStart, selEnd));
    setCaret(el.selectionEnd);
  };
  const accept = (index: number) => {
    const s = auto.suggestions[index];
    const t = auto.trigger;
    if (!s || !t) return;
    if (s.kind === 'mention') o.onMention(s.token);
    // Slash commands keep whatever arguments were typed after the name.
    const space = o.text.search(/\s/u);
    const end = s.kind === 'slash' ? (space === -1 ? o.text.length : space + 1) : t.end;
    replace(t.start, end, s.insert);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (isImeKey(e)) return true;
    if (auto.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        auto.move(e.key === 'ArrowDown' ? 1 : -1);
        return true;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
        e.preventDefault();
        accept(auto.active);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        auto.dismiss();
        return true;
      }
    }
    if (wrapSelection(e, replace)) {
      e.preventDefault();
      return true;
    }
    return false;
  };

  return {
    onKeyDown,
    syncCaret,
    replace,
    inputProps: {
      'aria-autocomplete': 'list',
      ...(auto.open
        ? { 'aria-controls': listId, 'aria-activedescendant': optionId(listId, auto.active) }
        : {}),
    },
    popover:
      auto.open && auto.trigger ? (
        <Suspense fallback={null}>
          <AutocompletePopover
            id={listId}
            anchor={o.anchor}
            kind={auto.trigger.kind}
            query={auto.trigger.query}
            suggestions={auto.suggestions}
            active={auto.active}
            onHover={auto.setActive}
            onPick={accept}
            conversationId={o.conversationId}
          />
        </Suspense>
      ) : null,
  };
}
