import { Upload } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import styles from './DropOverlay.module.css';

/** Synthetic or cross-frame drag events can arrive without a DataTransfer. */
function transfer(e: DragEvent): DataTransfer | null {
  return e.dataTransfer;
}

function hasFiles(e: DragEvent): boolean {
  return [...(transfer(e)?.types ?? [])].includes('Files');
}

/**
 * Drag-and-drop anywhere over the conversation. Enter/leave fire for every
 * child element, so a depth counter tells when the drag really left. In
 * WebKit the counter can desync if a row unmounts mid-drag (its leave never
 * fires), so window `dragend`/`drop`, and a `dragleave` whose
 * `relatedTarget` is null (the drag left the window, not just a child),
 * force it back to zero rather than trusting the running count.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, []);

  return {
    dragging,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver: (e: DragEvent) => {
        const dt = transfer(e);
        if (!dt || !hasFiles(e)) return;
        e.preventDefault();
        dt.dropEffect = 'copy';
      },
      // Leave and drop settle the overlay whatever they carry, so it can't get stuck.
      onDragLeave: (e: DragEvent) => {
        if (e.relatedTarget === null) {
          depth.current = 0;
          setDragging(false);
          return;
        }
        if (depth.current === 0) return;
        depth.current -= 1;
        if (depth.current === 0) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        const wasDragging = depth.current > 0;
        depth.current = 0;
        setDragging(false);
        const files = [...(transfer(e)?.files ?? [])];
        if (!wasDragging && files.length === 0) return;
        e.preventDefault();
        if (files.length > 0) onFiles(files);
      },
    },
  };
}

export function DropOverlay({ target }: { target: string }) {
  return (
    <div className={styles.overlay} aria-hidden data-snowdrop="drop-overlay">
      <div className={styles.card}>
        <span className={styles.icon}>
          <Upload size={28} />
        </span>
        <p className={styles.title}>Drop to add to your message</p>
        <p className={styles.hint}>For {target}. Nothing is sent until you press Enter.</p>
      </div>
    </div>
  );
}
