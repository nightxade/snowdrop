const OPEN_MENU = '[role="menu"][data-state="open"]';
const ANY_MENU = '[role="menu"]';
/** Frames to wait for the menu to be gone before running regardless. */
const CLOSE_FRAMES = 30;

/**
 * Runs `run` once the menus on the page have closed and handed focus back (a menu item that
 * opens a card: the card's own focus must come after the menu's). Gives up waiting after a while.
 */
export function afterMenusClosed(run: () => void): void {
  let frames = 0;
  const step = (): void => {
    if (document.querySelector(ANY_MENU) === null || (frames += 1) > CLOSE_FRAMES) {
      // After the focus return Radix schedules as the menu unmounts.
      setTimeout(run, 0);
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Runs `run` with no menu open. A menu (a dropdown, a context menu, a submenu) is a layer of its
 * own that a global shortcut must not act behind: it is closed first the way Esc closes it (the
 * topmost layer each time, so a submenu then its parent), and `run` follows once it is gone and
 * the menu has handed focus back to its trigger, so the command's own focus is the last word.
 * With no menu open `run` is synchronous.
 */
export function runWithMenusClosed(run: () => void): void {
  if (typeof document === 'undefined' || document.querySelector(ANY_MENU) === null) {
    run();
    return;
  }
  let frames = 0;
  const step = (): void => {
    if (document.querySelector(ANY_MENU) === null) {
      // After the focus return Radix schedules as the menu unmounts.
      setTimeout(run, 0);
      return;
    }
    if ((frames += 1) > CLOSE_FRAMES) {
      run();
      return;
    }
    const top = [...document.querySelectorAll<HTMLElement>(OPEN_MENU)].pop();
    top?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    requestAnimationFrame(step);
  };
  step();
}
