import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Avatar } from './Avatar';
import { Badge, formatBadgeCount } from './Badge';
import { splitCombo } from './Kbd';
import { DropdownMenu } from './Menu';
import { tidyMenu, type MenuEntry } from './menuModel';
import { Slot } from './Slot';
import { TooltipProvider } from './Tooltip';

afterEach(cleanup);

describe('Avatar', () => {
  it('shows initials when there is no image', () => {
    const { container } = render(<Avatar fallback="MO" color="red" label="Mira" />);
    expect(container.textContent).toBe('MO');
    expect(screen.getByRole('img', { name: 'Mira' })).toBeTruthy();
  });

  it('falls back to initials when the image fails to load', () => {
    const { container } = render(<Avatar src="/broken.png" fallback="MO" color="red" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('MO');
  });

  it('tries again when the source changes', () => {
    const { container, rerender } = render(<Avatar src="/a.png" fallback="A" color="red" />);
    fireEvent.error(container.querySelector('img')!);
    rerender(<Avatar src="/b.png" fallback="A" color="red" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/b.png');
  });
});

describe('Badge', () => {
  it('caps counts and hides zero', () => {
    expect(formatBadgeCount(120)).toBe('99+');
    const { container } = render(<Badge count={0} />);
    expect(container.textContent).toBe('');
    render(<Badge count={3} label="3 mentions" />);
    expect(screen.getByRole('status', { name: '3 mentions' }).textContent).toBe('3');
  });
});

describe('Kbd', () => {
  it('splits Windows/Linux and macOS combos into keycaps', () => {
    expect(splitCombo('Ctrl+Shift+M')).toEqual(['Ctrl', 'Shift', 'M']);
    expect(splitCombo('⇧⌘K')).toEqual(['⇧', '⌘', 'K']);
    expect(splitCombo('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(splitCombo('Esc')).toEqual(['Esc']);
  });
});

describe('tidyMenu', () => {
  it('drops leading, trailing and doubled separators (also in submenus)', () => {
    const item = (id: string): MenuEntry => ({ kind: 'item', id, label: id, onSelect: vi.fn() });
    const out = tidyMenu([
      { kind: 'separator', id: 's0' },
      item('a'),
      { kind: 'separator', id: 's1' },
      { kind: 'separator', id: 's2' },
      {
        kind: 'submenu',
        id: 'sub',
        label: 'Sub',
        items: [{ kind: 'separator', id: 'x' }, item('b')],
      },
      { kind: 'separator', id: 's3' },
    ]);
    expect(out.map((e) => e.id)).toEqual(['a', 's1', 'sub']);
    const sub = out[2];
    expect(sub?.kind === 'submenu' && sub.items.map((e) => e.id)).toEqual(['b']);
  });
});

describe('DropdownMenu', () => {
  it('is keyboard operable: opens, skips disabled items, selects with Enter', async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const third = vi.fn();
    const entries = (): MenuEntry[] => [
      { kind: 'item', id: 'one', label: 'One', onSelect: first },
      { kind: 'item', id: 'two', label: 'Two', disabled: true, onSelect: vi.fn() },
      { kind: 'separator', id: 'sep' },
      { kind: 'item', id: 'three', label: 'Three', danger: true, onSelect: third },
    ];
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
    const menu = await screen.findByRole('menu');
    expect(menu).toBeTruthy();
    // First item gets focus on open; ArrowDown skips the disabled one.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Three');
    expect(document.activeElement?.hasAttribute('data-danger')).toBe(true);
    await user.keyboard('{Enter}');
    expect(third).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('builds entries only when opened', () => {
    const entries = vi.fn((): MenuEntry[] => []);
    render(
      <DropdownMenu entries={entries}>
        <button type="button">Open</button>
      </DropdownMenu>,
    );
    expect(entries).not.toHaveBeenCalled();
  });
});

describe('Slot', () => {
  it('isolates a crashing plugin component behind a failure chip', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = vi.fn();
    const Good = ({ who }: { who: string }) => <span>hello {who}</span>;
    const Bad = () => {
      throw new Error('boom');
    };
    render(
      <TooltipProvider>
        <Slot
          name="test.slot"
          props={{ who: 'world' }}
          onError={onError}
          entries={[
            { id: 'bad', owner: 'evil-plugin', component: Bad },
            { id: 'good', owner: 'nice-plugin', component: Good },
            { id: 'bogus', owner: 'confused-plugin', component: 42 },
          ]}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.getByText('evil-plugin failed')).toBeTruthy();
    expect(screen.getByText('confused-plugin failed')).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('renders nothing for an empty slot', () => {
    const { container } = render(<Slot name="empty" props={{}} entries={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
