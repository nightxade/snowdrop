import { useEffect, useState } from 'react';
import type { AvatarRef, ConversationId } from '@/core/domain';
import { useSnowdrop } from './SnowdropContext';

export interface AvatarSrcOptions {
  /**
   * Changes when the picture may have changed (`Contact.avatarVersion`): a
   * shown avatar then asks the backend again.
   */
  version?: number | undefined;
  /** Shown while the backend has nothing for it, and for a backend that has no `resolveAvatarUrl`. */
  known?: string | undefined;
  /** Show nothing (and fetch nothing): the picture belongs to someone who hasn't been accepted. */
  held?: boolean;
}

function refFor(kind: AvatarRef['kind'], id: string): AvatarRef {
  return kind === 'group' ? { kind, id: id as ConversationId } : { kind, id };
}

/**
 * The picture for a person or group, once the avatar is on screen.
 *
 * Returns a callback ref for the avatar's element and the URL to show
 * (`undefined` = show the initials). Nothing is fetched until the element
 * has scrolled into view (a sidebar of hundreds asks for the handful on
 * screen), a remounted row is filled on its first frame from the backend's
 * cache, and a failed fetch is not retried in a loop: it simply shows the
 * initials. The backend dedupes and limits the calls themselves.
 */
export function useAvatarSrc(
  kind: AvatarRef['kind'],
  id: string | null | undefined,
  { version, known, held = false }: AvatarSrcOptions = {},
): [ref: (node: HTMLSpanElement | null) => void, src: string | undefined] {
  const { backend } = useSnowdrop();
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  const [resolved, setResolved] = useState<{ key: string; url: string | null } | null>(null);
  const resolve = backend.resolveAvatarUrl;
  const peek = backend.peekAvatarUrl;
  const enabled = !held && id !== null && id !== undefined && id !== '' && resolve !== undefined;

  // One-shot: once it has been on screen, it stays eligible (no refetch churn while scrolling).
  useEffect(() => {
    if (seen || !node || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [node, seen, enabled]);

  const peeked = enabled ? peek?.(refFor(kind, id)) : undefined;
  const wanted = enabled && seen && peeked === undefined;
  useEffect(() => {
    if (!wanted || !id) return;
    let live = true;
    const key = `${kind}:${id}`;
    resolve.call(backend, refFor(kind, id)).then(
      (url) => {
        if (live) setResolved({ key, url });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wanted, resolve, backend, kind, id, version]);

  if (held) return [setNode, undefined];
  // The backend's own memory first (it knows when a picture changed); what this
  // hook just fetched covers a backend that remembers nothing.
  const fetched = resolved?.key === `${kind}:${id}` ? resolved.url : null;
  const url = peeked === undefined ? fetched : peeked;
  return [setNode, typeof url === 'string' ? url : known];
}
