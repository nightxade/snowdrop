import { Toaster as Sonner, toast } from 'sonner';
import { useShellStyle } from '@/ui/hooks';
import styles from './Toaster.module.css';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  id: string;
  message: string;
  tone: ToastTone;
  /** Attribution line ("from Keyword Alerts"). */
  source?: string;
  onDismiss?: () => void;
}

/** Mount once. Themed through tokens; positioned away from the composer. */
export function Toaster() {
  // TUI docks jump-to-present (and "N new messages") in that same bottom-right
  // corner of the message pane, inset by one gap — the standard shell's offset
  // (clear of the composer) isn't tall enough to also clear that chip, so
  // toasts would paint over it. See overlays.css for the chip and toast square
  // bordered-chip styling in TUI.
  const tui = useShellStyle();
  return (
    <Sonner
      position="bottom-right"
      // Clear of the composer (and its typing line) at the bottom of the chat.
      offset={tui ? { bottom: 148, right: 16 } : { bottom: 104, right: 16 }}
      mobileOffset={{ bottom: 96, left: 12, right: 12 }}
      gap={8}
      visibleToasts={4}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: styles.toast ?? '',
          title: styles.title ?? '',
          description: styles.description ?? '',
          icon: styles.icon ?? '',
          success: styles.success ?? '',
          error: styles.error ?? '',
          info: styles.info ?? '',
        },
      }}
    />
  );
}

export function showToast({ id, message, tone, source, onDismiss }: ToastOptions): void {
  const options = {
    id,
    ...(source ? { description: source } : {}),
    ...(onDismiss ? { onDismiss, onAutoClose: onDismiss } : {}),
    duration: tone === 'error' ? 8000 : 4500,
  };
  if (tone === 'success') toast.success(message, options);
  else if (tone === 'error') toast.error(message, options);
  else toast(message, options);
}

export function dismissToast(id: string): void {
  toast.dismiss(id);
}
