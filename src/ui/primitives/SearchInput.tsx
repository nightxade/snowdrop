import { Search, X } from 'lucide-react';
import type { Ref } from 'react';
import { TextInput, type TextInputProps } from './TextInput';
import styles from './TextInput.module.css';

export interface SearchInputProps extends Omit<
  TextInputProps,
  'leading' | 'trailing' | 'onChange' | 'value'
> {
  value: string;
  onValueChange: (value: string) => void;
  ref?: Ref<HTMLInputElement> | undefined;
}

/** Text input with a search glyph and a clear button; Escape clears first, then bubbles. */
export function SearchInput({ value, onValueChange, onKeyDown, ref, ...rest }: SearchInputProps) {
  return (
    <TextInput
      ref={ref}
      type="search"
      value={value}
      leading={<Search />}
      trailing={
        value ? (
          <button
            type="button"
            className={styles.adornment}
            aria-label="Clear search"
            onClick={() => {
              onValueChange('');
            }}
          >
            <X />
          </button>
        ) : null
      }
      onChange={(e) => {
        onValueChange(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && value) {
          e.preventDefault();
          e.stopPropagation();
          onValueChange('');
        }
        onKeyDown?.(e);
      }}
      {...rest}
    />
  );
}
