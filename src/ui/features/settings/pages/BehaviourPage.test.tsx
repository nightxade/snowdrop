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

describe('Settings → Behaviour: link previews', () => {
  it('is not offered when the backend has no link_preview_fetch (the browser build)', async () => {
    snowdrop = await bootSnowdrop();
    expect(snowdrop.linkPreviewFetch).toBeNull();
    renderWithSnowdrop(snowdrop, <BehaviourPage />);
    expect(screen.queryByRole('switch', { name: 'Link previews' })).toBeNull();
  });

  it('is on by default and flips the setting when offered (desktop)', async () => {
    snowdrop = await bootSnowdrop();
    // Simulates the desktop build, where createSnowdrop wires this up to a
    // real fetch — the row's presence and the switch itself don't care which.
    (snowdrop as { linkPreviewFetch: unknown }).linkPreviewFetch = () => Promise.resolve(undefined);
    renderWithSnowdrop(snowdrop, <BehaviourPage />);

    expect(snowdrop.stores.settings.getState().behaviour.linkPreviews).toBe(true);
    const toggle = screen.getByRole('switch', { name: 'Link previews' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    act(() => {
      fireEvent.click(toggle);
    });

    expect(snowdrop.stores.settings.getState().behaviour.linkPreviews).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
