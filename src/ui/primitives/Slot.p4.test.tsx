import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginNamesContext, Slot } from './Slot';
import { TooltipProvider } from './Tooltip';

afterEach(cleanup);

describe('plugin crash chip (S6)', () => {
  it('names the plugin and shows one chip per plugin, however many rows crash', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Bad = () => {
      throw new Error('boom');
    };
    const rows = [1, 2, 3].map((n) => (
      <Slot
        key={n}
        name="message.decorations"
        props={{}}
        entries={[{ id: 'd', owner: 'message-tools', component: Bad }]}
      />
    ));
    render(
      <PluginNamesContext value={(id) => (id === 'message-tools' ? 'Message Tools' : id)}>
        <TooltipProvider>{rows}</TooltipProvider>
      </PluginNamesContext>,
    );
    expect(screen.getAllByText('Message Tools failed')).toHaveLength(1);
  });
});
