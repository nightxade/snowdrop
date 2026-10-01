import { useEffect, useState, type ReactNode } from 'react';
import type { Message } from '@/core/domain';
import { Skeleton } from '@/ui/primitives';
import styles from './ListPopover.module.css';

export type Load =
  { status: 'loading' } | { status: 'done'; messages: Message[] } | { status: 'error' };
/** Loads a list each time the popover opens (it's cheap and always fresh). */
export function useOnOpen(
  open: boolean,
  load: () => Promise<Message[]>,
  deps: readonly unknown[],
): Load {
  const [state, setState] = useState<{ open: boolean; load: Load }>({
    open: false,
    load: { status: 'loading' },
  });
  if (state.open !== open) setState({ open, load: { status: 'loading' } });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    load()
      .then((messages) => {
        if (!cancelled) setState({ open: true, load: { status: 'done', messages } });
      })
      .catch(() => {
        if (!cancelled) setState({ open: true, load: { status: 'error' } });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);
  return state.load;
}
export function PopoverFrame({
  title,
  icon,
  load,
  empty,
  render,
}: {
  title: string;
  icon: ReactNode;
  load: Load;
  empty: ReactNode;
  render: (m: Message) => ReactNode;
}) {
  return (
    <div className={styles.frame}>
      <header className={styles.header}>
        {icon}
        <h2 className={styles.title}>{title}</h2>
      </header>
      <div className={styles.body}>
        {load.status === 'loading' && (
          <div className={styles.list}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={64} radius="sm" />
            ))}
          </div>
        )}
        {load.status === 'error' && (
          <p className={styles.empty}>Couldn’t load this list. Try again.</p>
        )}
        {load.status === 'done' && load.messages.length === 0 && (
          <div className={styles.empty}>{empty}</div>
        )}
        {load.status === 'done' && load.messages.length > 0 && (
          <ul className={styles.list}>
            {load.messages.map((m) => (
              <li key={m.id}>{render(m)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
