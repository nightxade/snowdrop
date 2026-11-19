import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, DropdownMenu } from './Menu';
import { runWithMenusClosed } from './menuClose';
import { resetMenuOpeners } from './menuReturn';
import { TooltipProvider } from './Tooltip';

afterEach(() => {
  cleanup();
  resetMenuOpeners();
});

const entries = () => [
  { kind: 'item' as const, id: 'a', label: 'A', onSelect: () => undefined },
  {
    kind: 'submenu' as const,
    id: 'more',
    label: 'More',
    items: [{ kind: 'item' as const, id: 'b', label: 'B', onSelect: () => undefined }],
  },
];

describe('runWithMenusClosed', () => {
  it('runs at once with no menu open', () => {
    const run = vi.fn();
    runWithMenusClosed(run);
    expect(run).toHaveBeenCalledOnce();
  });

  it('closes a dropdown menu first, then runs with focus back on its trigger', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <DropdownMenu entries={entries} label="Options">
          <button type="button">Open</button>
        </DropdownMenu>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Open' });
    act(() => {
      trigger.focus();
    });
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    let menuAtRun: boolean | null = null;
    let focusAtRun: Element | null = null;
    const run = vi.fn(() => {
      menuAtRun = document.querySelector('[role="menu"]') !== null;
      focusAtRun = document.activeElement;
    });
    runWithMenusClosed(run);
    expect(run).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
    });
    expect(menuAtRun).toBe(false);
    expect(focusAtRun).toBe(trigger);
  });

  it('closes an open submenu and its menu, and a context menu too', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ContextMenu entries={entries} label="Options">
          <div role="group" tabIndex={0} aria-label="Row">
            row
          </div>
        </ContextMenu>
      </TooltipProvider>,
    );
    const row = screen.getByRole('group', { name: 'Row' });
    act(() => {
      row.focus();
    });
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(await screen.findByRole('menuitem', { name: 'More' }));
    await waitFor(() => {
      expect(screen.getAllByRole('menu').length).toBeGreaterThan(0);
    });
    const run = vi.fn(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });
    runWithMenusClosed(run);
    await waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
    });
  });
});
