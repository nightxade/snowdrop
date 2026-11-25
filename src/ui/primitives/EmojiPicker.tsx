import * as RadixPopover from '@radix-ui/react-popover';
import { lazy, Suspense, useRef, useState, type ReactNode, type ReactElement } from 'react';
import { useContainedWheel } from '@/ui/hooks/useContainedWheel';
import { Button } from './Button';
import { focusQuietly } from './focusQuietly';
import { EMOJIBASE_URL, type EmojiPickerProps } from './emojiPickerTypes';
import styles from './EmojiPicker.module.css';

export { EMOJIBASE_URL, type EmojiPickerProps };

// frimousse (and its data handling) is only fetched the first time a picker opens.
const Panel = lazy(() =>
  import('./EmojiPickerPanel').then((m) => ({ default: m.EmojiPickerPanel })),
);

/** The emoji grid; a same-sized placeholder shows while the code loads. */
export function EmojiPicker(props: EmojiPickerProps) {
  return (
    <Suspense
      fallback={
        <div className={styles.root}>
          <div className={styles.status}>Loading emoji…</div>
        </div>
      }
    >
      <Panel {...props} />
    </Suspense>
  );
}

export interface EmojiPickerPopoverProps extends Omit<EmojiPickerProps, 'autoFocus'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The element the picker opens from (a button that forwards refs). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Keep the picker open after a pick (e.g. adding several reactions). */
  stayOpen?: boolean;
  /** Optional personal image collection, only offered when the caller can attach files. */
  customContent?: ReactNode;
  /** Where focus goes when it closes, when not the button it opened from (read at close). */
  returnFocus?: () => HTMLElement | null | undefined;
}

/** The picker in a popover, anchored to (and toggled by) its child. */
export function EmojiPickerPopover({
  open,
  onOpenChange,
  children,
  side = 'top',
  align = 'end',
  onSelect,
  stayOpen,
  columns,
  customContent,
  returnFocus,
}: EmojiPickerPopoverProps) {
  const [custom, setCustom] = useState(false);
  const containWheel = useContainedWheel();
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild ref={trigger}>
        {children}
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          ref={containWheel}
          className={styles.popover}
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          aria-label="Emoji picker"
          onCloseAutoFocus={(e) => {
            // Back on the button (or where the caller says) without popping its tooltip, as after a dialog.
            e.preventDefault();
            const target = returnFocus?.() ?? trigger.current;
            if (target?.isConnected) focusQuietly(target);
          }}
        >
          {customContent && (
            <div className={styles.modes} aria-label="Emoji collection">
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={!custom}
                onClick={() => {
                  setCustom(false);
                }}
              >
                Emoji
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={custom}
                onClick={() => {
                  setCustom(true);
                }}
              >
                My emoji
              </Button>
            </div>
          )}
          {open && custom && customContent
            ? customContent
            : open && (
                <EmojiPicker
                  {...(columns !== undefined ? { columns } : {})}
                  onSelect={(emoji) => {
                    onSelect(emoji);
                    if (!stayOpen) onOpenChange(false);
                  }}
                />
              )}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
