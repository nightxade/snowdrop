import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { MenuEntry } from '@/ui/primitives';
import { MenuEntryButtons } from './MenuEntryButtons';

afterEach(cleanup);

function entries(spies: Record<string, () => void>): MenuEntry[] {
  return [
    { kind: 'label', id: 'l', label: 'Actions' },
    { kind: 'item', id: 'go', label: 'Go', onSelect: spies['go'] ?? vi.fn() },
    { kind: 'item', id: 'off', label: 'Off', disabled: true, onSelect: spies['off'] ?? vi.fn() },
    { kind: 'separator', id: 's' },
    { kind: 'check', id: 'pin', label: 'Pinned', checked: true, onSelect: spies['pin'] ?? vi.fn() },
    {
      kind: 'submenu',
      id: 'more',
      label: 'More',
      items: [
        { kind: 'item', id: 'inner', label: 'Inner', onSelect: spies['inner'] ?? vi.fn() },
        { kind: 'item', id: 'dis', label: 'Nope', disabled: true, onSelect: vi.fn() },
      ],
    },
    { kind: 'submenu', id: 'locked', label: 'Locked', disabled: true, items: [] },
  ];
}

describe('MenuEntryButtons', () => {
  it('renders every kind: disabled items are inert and a check shows its state', async () => {
    const user = userEvent.setup();
    const go = vi.fn();
    const off = vi.fn();
    const pin = vi.fn();
    const done = vi.fn();
    render(
      <div>
        <MenuEntryButtons entries={entries({ go, off, pin })} onDone={done} />
      </div>,
    );
    expect(screen.getByText('Actions')).toBeTruthy();
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Off' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Locked' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Pinned' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Off' }));
    expect(off).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(go).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledTimes(1);
    expect(
      (await axe(document.body, { rules: { region: { enabled: false } } })).violations,
    ).toEqual([]);
  });

  it('opens a submenu with the same items, disabled ones included, and then finishes', async () => {
    const user = userEvent.setup();
    const inner = vi.fn();
    const done = vi.fn();
    render(<MenuEntryButtons entries={entries({ inner })} onDone={done} />);
    await user.click(screen.getByRole('button', { name: /^More/u }));
    const menu = await screen.findByRole('menu');
    expect(menu.querySelector('[aria-disabled="true"]')?.textContent).toBe('Nope');
    await user.click(screen.getByRole('menuitem', { name: 'Inner' }));
    expect(inner).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });
});
