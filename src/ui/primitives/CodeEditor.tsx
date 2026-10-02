import { useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import styles from './CodeEditor.module.css';

export interface CodeEditorProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
> {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name. */
  label: string;
}

const INDENT = '  ';

/** Inserts through the editing pipeline so Ctrl+Z undoes it like typing. */
function insert(el: HTMLTextAreaElement, text: string): void {
  let done: boolean;
  try {
    // Deprecated, but still the only way to keep native undo for textareas.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    done = document.execCommand('insertText', false, text);
  } catch {
    done = false;
  }
  if (!done) el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
}

/**
 * Monospace textarea with a line-number gutter. Tab indents (two spaces),
 * Shift+Tab outdents the current line. Escape releases Tab for one press so
 * keyboard users can always leave the field.
 */
export function CodeEditor({ value, onValueChange, label, className, ...rest }: CodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const [released, setReleased] = useState(false);
  const lines = value.split('\n').length;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Escape') {
      setReleased(true);
      return;
    }
    if (e.key !== 'Tab' || released || e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key !== 'Tab') setReleased(false);
      return;
    }
    e.preventDefault();
    if (!e.shiftKey) {
      insert(el, INDENT);
    } else {
      const start = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
      if (el.value.startsWith(INDENT, start)) {
        const caret = el.selectionStart;
        el.setSelectionRange(start, start + INDENT.length);
        insert(el, '');
        const next = Math.max(start, caret - INDENT.length);
        el.setSelectionRange(next, next);
      }
    }
    onValueChange(el.value);
  };

  return (
    <div className={[styles.editor, className].filter(Boolean).join(' ')}>
      <div ref={gutter} className={styles.gutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <textarea
        ref={ref}
        className={styles.area}
        value={value}
        aria-label={label}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => {
          onValueChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setReleased(false);
        }}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        {...rest}
      />
    </div>
  );
}
