import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuEntry } from '@/ui/primitives';
import { MessageActionSheet } from './MessageActionSheet';

afterEach(cleanup);

describe('MessageActionSheet', () => {
  it('shows whether a check entry is on, and that a submenu chip can be disabled', () => {
    const entries = (): MenuEntry[] => [
      { kind: 'check', id: 'on', label: 'Pinned', checked: true, onSelect: vi.fn() },
      { kind: 'check', id: 'off', label: 'Muted', checked: false, onSelect: vi.fn() },
      {
        kind: 'submenu',
        id: 'react',
        label: 'React',
        items: [{ kind: 'item', id: 'x', label: 'X', disabled: true, onSelect: vi.fn() }],
      },
    ];
    render(<MessageActionSheet open onOpenChange={() => undefined} entries={entries} />);
    expect(screen.getByRole('button', { name: 'Pinned' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Muted' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'X' }).disabled).toBe(true);
  });
});
