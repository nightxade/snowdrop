import { Toaster as Sonner, toast } from 'sonner';
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
  return (
    <Sonner
      position="bottom-right"
      offset={16}
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
