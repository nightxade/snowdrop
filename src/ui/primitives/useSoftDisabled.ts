import { useState, type FocusEvent } from 'react';

/**
 * WebKit drops focus to the page when the focused button becomes `disabled` (a Save that goes
 * inert once saved, a Reset that has nothing left to reset). While a control that has focus is
 * disabled it stays focusable instead: `soft` is true (the caller sets `aria-disabled` and
 * ignores activation) and the real `disabled` attribute only applies once focus has left. A
 * control that is disabled without focus is disabled as ever.
 */
export function useSoftDisabled(disabled: boolean | undefined): {
  /** The `disabled` attribute to render. */
  hard: boolean;
  /** Disabled, but holding focus: look disabled and ignore activation. */
  soft: boolean;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
} {
  const [focused, setFocused] = useState(false);
  const off = disabled === true;
  return {
    hard: off && !focused,
    soft: off && focused,
    onFocus: () => {
      setFocused(true);
    },
    onBlur: () => {
      setFocused(false);
    },
  };
}
