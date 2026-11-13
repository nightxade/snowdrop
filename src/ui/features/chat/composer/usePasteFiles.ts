import { describeFailure } from '@/ui/lib/connectionErrors';
import { useCallback, type ClipboardEvent } from 'react';

/**
 * The textarea's paste handler: pasted files become attachments. Ordinary text paste is left
 * to the browser; a clipboard only the native side can read goes through `readClipboardFiles`.
 */
export function usePasteFiles(
  addFiles: (files: readonly File[]) => void,
  /** Read when a paste happens, so a reader that is set later still counts. */
  getClipboardReader: () => (() => Promise<File[]>) | null | undefined,
  setError: (error: string | null) => void,
) {
  return useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const reader = getClipboardReader();
      const files = [...e.clipboardData.files];
      // Some webviews expose file clipboard entries only as items.
      // Prefer files when available: both lists can describe the same data.
      if (files.length === 0) {
        for (const item of Array.from(e.clipboardData.items)) {
          if (item.kind !== 'file') continue;
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
      } else if (reader) {
        const types = Array.from(e.clipboardData.types);
        const plain = e.clipboardData.getData('text/plain');
        // Keep ordinary text paste synchronous. Native-only images have
        // no text; file managers advertise URI or copied-files formats.
        const native =
          !plain ||
          types.includes('Files') ||
          types.includes('x-special/gnome-copied-files') ||
          (types.includes('text/uri-list') && /^(file:\/\/|\/)/u.test(plain.trim()));
        if (!native) return;
        e.preventDefault();
        const source = e.currentTarget;
        void reader()
          .then((copied) => {
            // A slow clipboard owner must not attach to a different chat.
            if (source.isConnected) addFiles(copied);
          })
          .catch((error: unknown) => {
            if (source.isConnected) setError(describeFailure(error));
          });
      }
    },
    [addFiles, getClipboardReader, setError],
  );
}
