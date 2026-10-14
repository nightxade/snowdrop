/**
 * The TUI shell's status line is built entirely from the `status.items`
 * slot (`src/core/plugins/registries.ts`): core and plugins contribute to
 * it exactly alike, which is how the Vim Mode plugin's NORMAL/INSERT item
 * ends up beside core's without this component knowing Vim exists.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreCommand } from '@/core/commands';
import { Registries } from '@/core/plugins';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { StatusLine } from './StatusLine';

afterEach(cleanup);

function fakeApp(registries: Registries, execute: ReturnType<typeof vi.fn>): AppServices {
  return { registries, commands: { execute } } as unknown as AppServices;
}

describe('StatusLine', () => {
  it("renders core's and a plugin's status items side by side, in registration order", () => {
    const registries = new Registries();
    registries.statusItems.add({
      id: 'conversation',
      owner: 'core',
      component: () => 'book nook',
    });
    registries.statusItems.add({ id: 'unread', owner: 'core', component: () => '3 unread' });
    // The Vim Mode plugin contributes its own item the same way core does.
    registries.statusItems.add({ id: 'mode-pill', owner: 'vim-mode', component: () => 'NORMAL' });

    render(
      <SnowdropContextProvider value={fakeApp(registries, vi.fn())}>
        <StatusLine />
      </SnowdropContextProvider>,
    );

    const bar = document.querySelector('[data-snowdrop="status-line"]')!;
    expect(bar).not.toBeNull();
    const text = bar.textContent;
    expect(text.indexOf('book nook')).toBeLessThan(text.indexOf('3 unread'));
    expect(text.indexOf('3 unread')).toBeLessThan(text.indexOf('NORMAL'));
  });

  it('updates live as items are added and removed (plugin enabled/disabled)', () => {
    const registries = new Registries();
    render(
      <SnowdropContextProvider value={fakeApp(registries, vi.fn())}>
        <StatusLine />
      </SnowdropContextProvider>,
    );
    expect(screen.queryByText('NORMAL')).toBeNull();

    let dispose!: () => void;
    act(() => {
      dispose = registries.statusItems.add({
        id: 'mode-pill',
        owner: 'vim-mode',
        component: () => 'NORMAL',
      });
    });
    expect(screen.getByText('NORMAL')).toBeTruthy();

    act(() => {
      dispose();
    });
    expect(screen.queryByText('NORMAL')).toBeNull();
  });

  it('"? for keys" opens the keyboard-shortcuts dialog', () => {
    const execute = vi.fn();
    render(
      <SnowdropContextProvider value={fakeApp(new Registries(), execute)}>
        <StatusLine />
      </SnowdropContextProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '? for keys' }));
    expect(execute).toHaveBeenCalledWith(CoreCommand.ShortcutHelp);
  });
});
