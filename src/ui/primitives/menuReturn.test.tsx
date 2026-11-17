import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextMenu, DropdownMenu } from './Menu';
import { Modal } from './Modal';
import { resetMenuOpeners } from './menuReturn';
import { TooltipProvider } from './Tooltip';

afterEach(() => {
  cleanup();
  resetMenuOpeners();
});

function Harness({ kind, rows = 1 }: { kind: 'dropdown' | 'context'; rows?: number }) {
  const [open, setOpen] = useState(false);
  const entries = () => [
    {
      kind: 'item' as const,
      id: 'go',
      label: 'Go',
      onSelect: () => {
        setOpen(true);
      },
    },
  ];
  return (
    <TooltipProvider>
      {kind === 'dropdown' ? (
        <DropdownMenu entries={entries} label="Options">
          <button type="button">Open</button>
        </DropdownMenu>
      ) : (
        Array.from({ length: rows }, (_, i) => (
          <ContextMenu key={i} entries={entries} label="Options">
            <div role="group" tabIndex={0} aria-label={i === 0 ? 'Row' : `Row ${i + 1}`}>
              row
            </div>
          </ContextMenu>
        ))
      )}
      <Modal open={open} onOpenChange={setOpen} title="Question">
        <p>Sure?</p>
      </Modal>
    </TooltipProvider>
  );
}

describe('a dialog opened from a menu item', () => {
  it('gives focus back to the button that opened a dropdown menu', async () => {
    const user = userEvent.setup();
    render(<Harness kind="dropdown" />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    act(() => {
      trigger.focus();
    });
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Go' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('gives focus back to the row a context menu was opened from', async () => {
    const user = userEvent.setup();
    render(<Harness kind="context" />);
    const row = screen.getByRole('group', { name: 'Row' });
    act(() => {
      row.focus();
    });
    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.click(await screen.findByRole('menuitem', { name: 'Go' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(row);
    });
  });

  it("gives focus to the row right-clicked while nothing had focus, not an earlier menu's", async () => {
    const user = userEvent.setup();
    render(<Harness kind="context" rows={2} />);
    const first = screen.getByRole('group', { name: 'Row' });
    const second = screen.getByRole('group', { name: 'Row 2' });
    act(() => {
      first.focus();
    });
    await user.pointer({ keys: '[MouseRight]', target: first });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    // A bare contextmenu event: the row takes no focus from it.
    fireEvent.contextMenu(second);
    await user.click(await screen.findByRole('menuitem', { name: 'Go' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(second);
    });
  });
});
