import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import styles from './VirtualList.module.css';

/** Lists with up to this many rows are rendered whole: windowing only pays off for long ones. */
export const VIRTUAL_THRESHOLD = 80;

export interface VirtualListHandle {
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'end') => void;
  /** Scrolls only as far as needed to bring the row into view. */
  scrollIntoView: (index: number) => void;
}

export interface VirtualListProps {
  count: number;
  /** The row at `index`. */
  itemContent: (index: number) => ReactNode;
  itemKey: (index: number) => string;
  /** A typical row's height in px: the first guess, until rows are measured. */
  rowHeight: number;
  /** The tallest the list grows before it scrolls, as a CSS length. */
  maxHeight: string;
  /** `ul` wraps each row in an `li`; `div` renders the rows as they are. */
  tag?: 'ul' | 'div';
  className?: string | undefined;
  /** Rows before which the list stops being windowed. */
  threshold?: number;
  'aria-label'?: string;
  handleRef?: Ref<VirtualListHandle>;
  /** Called with the first and last rows that are rendered (overscan included). */
  onRange?: (first: number, last: number) => void;
}

interface ListContext {
  tag: 'ul' | 'div';
  count: number;
  label: string | undefined;
}

const List: Components<unknown, ListContext>['List'] = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLElement> & { context?: ListContext }
>(function List({ context, children, style, ...rest }, ref) {
  if (context?.tag === 'ul') {
    return (
      <ul
        {...rest}
        style={style}
        ref={ref as unknown as Ref<HTMLUListElement>}
        aria-label={context.label}
      >
        {children}
      </ul>
    );
  }
  return (
    <div {...rest} style={style} ref={ref}>
      {children}
    </div>
  );
});

const Item: Components<unknown, ListContext>['Item'] = function Item({
  context,
  children,
  item: _item,
  ...rest
}) {
  const index = rest['data-index'];
  if (context.tag === 'ul') {
    return (
      <li {...rest} aria-posinset={index + 1} aria-setsize={context.count}>
        {children}
      </li>
    );
  }
  return <div {...rest}>{children}</div>;
};

/**
 * Virtuoso makes its scroller a tab stop. That is an extra stop (and not an
 * allowed child inside a listbox): the rows are the way in, so it is left out.
 */
const Scroller: NonNullable<Components<unknown, ListContext>['Scroller']> = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    context?: ListContext | undefined;
    tabIndex?: number | undefined;
  }
>(function Scroller({ context: _context, tabIndex: _tabIndex, children, ...rest }, ref) {
  return (
    <div {...rest} ref={ref}>
      {children}
    </div>
  );
});

const components: Components<unknown, ListContext> = { List, Item, Scroller };

/**
 * A scrolling list that only mounts the rows near the viewport once it is
 * long (the same virtualiser the message list uses). It sizes itself to its
 * rows up to `maxHeight`, so it drops into a dialog like a plain list. Short
 * lists are rendered whole, with the same markup and classes.
 */
export function VirtualList({
  count,
  itemContent,
  itemKey,
  rowHeight,
  maxHeight,
  tag = 'div',
  className,
  threshold = VIRTUAL_THRESHOLD,
  'aria-label': label,
  handleRef,
  onRange,
}: VirtualListProps) {
  const virtuoso = useRef<VirtuosoHandle | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useImperativeHandle(
    handleRef,
    () => ({
      scrollIntoView: (index) => {
        virtuoso.current?.scrollIntoView({ index, behavior: 'auto' });
      },
      scrollToIndex: (index, align = 'center') => {
        virtuoso.current?.scrollToIndex({ index, align, behavior: 'auto' });
      },
    }),
    [],
  );
  const context = useMemo<ListContext>(() => ({ tag, count, label }), [tag, count, label]);
  const onTotalHeight = useCallback((height: number) => {
    setMeasured(height);
  }, []);
  const style: CSSProperties = { height: measured ?? count * rowHeight, maxHeight };

  if (count <= threshold) {
    const Tag = tag;
    return (
      <Tag className={className} style={{ maxHeight, overflowY: 'auto' }} aria-label={label}>
        {Array.from({ length: count }, (_, index) =>
          tag === 'ul' ? <li key={itemKey(index)}>{itemContent(index)}</li> : itemContent(index),
        )}
      </Tag>
    );
  }

  return (
    <Virtuoso
      ref={virtuoso}
      className={[styles.list, className].filter(Boolean).join(' ')}
      style={style}
      context={context}
      components={components}
      totalCount={count}
      defaultItemHeight={rowHeight}
      increaseViewportBy={{ top: rowHeight * 6, bottom: rowHeight * 10 }}
      computeItemKey={itemKey}
      itemContent={itemContent}
      totalListHeightChanged={onTotalHeight}
      {...(onRange
        ? {
            rangeChanged: (range: { startIndex: number; endIndex: number }) => {
              onRange(range.startIndex, range.endIndex);
            },
          }
        : {})}
    />
  );
}
