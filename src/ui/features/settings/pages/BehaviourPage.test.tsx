import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { BehaviourPage } from './BehaviourPage';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

describe('Settings → Behaviour: focus the message box', () => {
  it('is off by default and flips the setting when toggled', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <BehaviourPage />);

    expect(snowdrop.stores.settings.getState().behaviour.focusComposerOnOpen).toBe(false);
    const toggle = screen.getByRole('switch', {
      name: 'Focus the message box when opening a conversation',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    act(() => {
      fireEvent.click(toggle);
    });

    expect(snowdrop.stores.settings.getState().behaviour.focusComposerOnOpen).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});
