import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { uiSelectors } from '@/core/stores';
import { useHearth } from '@/ui/hooks';
import { dismissToast, showToast, Toaster } from '@/ui/primitives';

/**
 * The ui store owns the toast queue (plugins push via ctx.toast); sonner only
 * renders it. New entries are shown once; dismissing either side removes both.
 */
export function ToastBridge() {
  const { stores, plugins } = useHearth();
  const toasts = useStore(stores.ui, uiSelectors.toasts);
  const shown = useRef(new Set<string>());

  useEffect(() => {
    const live = new Set(toasts.map((t) => t.id));
    for (const toast of toasts) {
      if (shown.current.has(toast.id)) continue;
      shown.current.add(toast.id);
      const plugin = toast.source === 'core' ? undefined : plugins.get(toast.source);
      showToast({
        id: toast.id,
        message: toast.message,
        tone: toast.kind,
        ...(plugin ? { source: `From ${plugin.definition.name}` } : {}),
        onDismiss: () => {
          stores.ui.getState().dismissToast(toast.id);
        },
      });
    }
    // Dropped from the queue (cap reached, or dismissed by code): hide it too.
    for (const id of shown.current) {
      if (!live.has(id)) {
        dismissToast(id);
        shown.current.delete(id);
      }
    }
  }, [toasts, stores, plugins]);

  return <Toaster />;
}
