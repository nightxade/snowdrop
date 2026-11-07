import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  GALLERY_KINDS,
  type ConversationId,
  type GalleryKind,
  type Message,
  type MessageId,
} from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { reconcileGallery, type LiveWindow } from './galleryLive';

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
  | {
      type: 'page';
      kind: GalleryKind;
      messages: Message[];
      done: boolean;
      /** The live window as the page arrived: what was deleted meanwhile is not shown. */
      live: LiveWindow | undefined;
      known: ReadonlySet<MessageId>;
    }
  /** The conversation's live window changed: new media appears, deleted media goes. */
  | { type: 'live'; live: LiveWindow; known: ReadonlySet<MessageId> }
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
  if (action.type === 'live') {
    let next = state;
    for (const kind of GALLERY_KINDS) {
      const tab = state[kind];
      // A tab with a page on its way reconciles when the page lands.
      if (!tab.started || tab.loading) continue;
      const messages = reconcileGallery(tab.messages, kind, tab.done, action.live, action.known);
      if (messages !== tab.messages)
        next = { ...next, [kind]: { ...tab, messages: [...messages] } };
    }
    return next;
  }
  const tab = state[action.kind];
  switch (action.type) {
    case 'start':
      return { ...state, [action.kind]: { ...tab, loading: true, failed: false, started: true } };
    case 'page': {
      const have = new Set(tab.messages.map((m) => m.id));
      const merged = [...tab.messages, ...action.messages.filter((m) => !have.has(m.id))];
      return {
        ...state,
        [action.kind]: {
          ...tab,
          messages: action.live
            ? [...reconcileGallery(merged, action.kind, action.done, action.live, action.known)]
            : merged,
          done: action.done,
          loading: false,
        },
      };
    }
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
  const { repository, stores } = useSnowdrop();
  const [tabs, dispatch] = useReducer(reduce, undefined, initial);
  const latest = useRef(tabs);
  const inflight = useRef(new Set<GalleryKind>());
  const abort = useRef<AbortController | null>(null);
  // What the live window held when the panel opened: stored history covers those; only
  // messages arriving after are added from the window.
  const known = useMemo<ReadonlySet<MessageId>>(
    () => new Set(stores.messages.getState().windows[conversationId]?.ids ?? []),
    [stores, conversationId],
  );

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

  // Messages arriving, being deleted or expiring while the panel is open.
  useEffect(
    () =>
      stores.messages.subscribe((state, previous) => {
        const window = state.windows[conversationId];
        const before = previous.windows[conversationId];
        if (!window || window === before) return;
        const gone = new Set((before?.ids ?? []).filter((id) => !(id in window.byId)));
        dispatch({
          type: 'live',
          live: {
            ids: window.ids,
            byId: window.byId,
            anchoredToPresent: window.anchoredToPresent,
            gone,
          },
          known,
        });
      }),
    [stores, conversationId, known],
  );

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
          dispatch({
            type: 'page',
            kind,
            messages,
            done: messages.length < GALLERY_PAGE,
            live: stores.messages.getState().windows[conversationId],
            known,
          });
        })
        .catch(() => {
          if (signal.aborted) return;
          inflight.current.delete(kind);
          dispatch({ type: 'fail', kind });
        });
    },
    [repository, stores, conversationId, known],
  );

  return { tabs, loadMore };
}
