import { Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import styles from './DropOverlay.module.css';

function hasFiles(e: DragEvent): boolean {
  return [...e.dataTransfer.types].includes('Files');
}

/**
 * Drag-and-drop anywhere over the conversation. Enter/leave fire for every
 * child element, so a depth counter tells when the drag really left.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
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
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        onFiles([...e.dataTransfer.files]);
      },
    },
  };
}

export function DropOverlay({ target }: { target: string }) {
  return (
    <div className={styles.overlay} aria-hidden data-shrike="drop-overlay">
      <div className={styles.card}>
        <span className={styles.icon}>
          <Upload size={28} />
        </span>
        <p className={styles.title}>Drop to send to {target}</p>
        <p className={styles.hint}>Files are added to your message; press Enter to send.</p>
      </div>
    </div>
  );
}
