import { useCallback, useEffect, useReducer, useRef } from 'react';
import { type ConversationId, type GalleryKind, type Message } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';

/** Messages fetched per page of a tab. */
export const GALLERY_PAGE = 40;

export interface GalleryTabState {
  /** Newest first, as the repository returns them. */
  messages: Message[];
  /** The history ran out: nothing older to load. */
  done: boolean;
  loading: boolean;
  failed: boolean;
  /** At least one page has been asked for (an unvisited tab loads nothing). */
  started: boolean;
}

type State = Record<GalleryKind, GalleryTabState>;
type Action =
  | { type: 'start'; kind: GalleryKind }
  | { type: 'page'; kind: GalleryKind; messages: Message[]; done: boolean }
  | { type: 'fail'; kind: GalleryKind };

const blank: GalleryTabState = {
  messages: [],
  done: false,
  loading: false,
  failed: false,
  started: false,
};

const initial = (): State => ({ media: blank, audio: blank, files: blank, links: blank });

function reduce(state: State, action: Action): State {
  const tab = state[action.kind];
  switch (action.type) {
    case 'start':
      return { ...state, [action.kind]: { ...tab, loading: true, failed: false, started: true } };
    case 'page':
      return {
        ...state,
        [action.kind]: {
          ...tab,
          messages: [...tab.messages, ...action.messages],
          done: action.done,
          loading: false,
        },
      };
    case 'fail':
      return { ...state, [action.kind]: { ...tab, loading: false, failed: true } };
  }
}

export interface Gallery {
  tabs: State;
  /** Fetches the next page of a tab, unless one is on its way or the history is exhausted. */
  loadMore: (kind: GalleryKind) => void;
}

/**
 * A conversation's gallery tabs, each paged newest first from the local
 * history. A tab only loads once someone looks at it; leaving the
 * conversation (or closing the panel) abandons whatever scan is running.
 */
export function useGallery(conversationId: ConversationId): Gallery {
  const { repository } = useSnowdrop();
  const [tabs, dispatch] = useReducer(reduce, undefined, initial);
  const latest = useRef(tabs);
  const inflight = useRef(new Set<GalleryKind>());
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    latest.current = tabs;
  });

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    const running = inflight.current;
    return () => {
      controller.abort();
      running.clear();
    };
  }, [conversationId]);

  const loadMore = useCallback(
    (kind: GalleryKind) => {
      const tab = latest.current[kind];
      const signal = abort.current?.signal;
      if (tab.done || inflight.current.has(kind) || !signal || signal.aborted) return;
      inflight.current.add(kind);
      // Mirrored at once: a second call before React re-renders must see it.
      latest.current = { ...latest.current, [kind]: { ...tab, loading: true, started: true } };
      dispatch({ type: 'start', kind });
      const before = tab.messages.at(-1)?.seq;
      repository
        .media(conversationId, kind, {
          ...(before === undefined ? {} : { before }),
          limit: GALLERY_PAGE,
          signal,
        })
        .then((messages) => {
          if (signal.aborted) return;
          inflight.current.delete(kind);
          dispatch({ type: 'page', kind, messages, done: messages.length < GALLERY_PAGE });
        })
        .catch(() => {
          if (signal.aborted) return;
          inflight.current.delete(kind);
          dispatch({ type: 'fail', kind });
        });
    },
    [repository, conversationId],
  );

  return { tabs, loadMore };
}
