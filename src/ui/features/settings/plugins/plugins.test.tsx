import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin, defineSettings } from '@/core/plugins';
import { bootSnowdrop, renderWithSnowdrop, settle } from '@/test/renderWithSnowdrop';
import type { Snowdrop } from '@/app/createSnowdrop';
import { PluginSettingsForm } from './PluginSettingsForm';
import { PluginsPage } from './PluginsPage';
import { filterPlugins } from './usePlugins';

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

const card = (name: string) =>
  screen.getByRole('heading', { name }).closest('article') as HTMLElement;

describe('Plugins page', () => {
  it('starts and stops a plugin live from its card', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <PluginsPage />);
    const decorations = () => snowdrop!.registries.messageDecorations.list().map((d) => d.id);
    expect(decorations()).not.toContain('relative-time');

    const toggle = within(card('Relative Timestamps')).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => {
      fireEvent.click(toggle);
    });
    await settle(snowdrop);
    expect(snowdrop.plugins.get('relative-timestamps')).toMatchObject({
      enabled: true,
      status: 'running',
    });
    expect(decorations()).toContain('relative-time');
    expect(
      within(card('Relative Timestamps')).getByRole('switch').getAttribute('aria-checked'),
    ).toBe('true');

    act(() => {
      fireEvent.click(within(card('Relative Timestamps')).getByRole('switch'));
    });
    await settle(snowdrop);
    expect(snowdrop.plugins.get('relative-timestamps')?.status).toBe('stopped');
    expect(decorations()).not.toContain('relative-time');
  });

  it('opens the generated settings form from the cog', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <PluginsPage />);
    act(() => {
      fireEvent.click(
        within(card('Keyword Alerts')).getByRole('button', { name: 'Keyword Alerts settings' }),
      );
    });
    const dialog = await screen.findByRole('dialog', { name: 'Keyword Alerts' });
    const keywords = within(dialog).getByLabelText('Keywords');
    act(() => {
      fireEvent.change(keywords, { target: { value: 'deploy, lunch' } });
    });
    expect(snowdrop.stores.settings.getState().plugins['keyword-alerts']?.settings.keywords).toBe(
      'deploy, lunch',
    );
  });

  it('shows a failed plugin with its error, retries, and keeps focus on the card', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <PluginsPage />);
    // Message Tools registers hover actions; make that blow up until we say so.
    const list = snowdrop.registries.hoverActions;
    const original = list.add.bind(list);
    let fail = true;
    list.add = (entry) => {
      if (fail) throw new Error('hover bar exploded');
      return original(entry);
    };
    act(() => {
      fireEvent.click(within(card('Message Tools')).getByRole('switch'));
    });
    await settle(snowdrop);
    const alert = within(card('Message Tools')).getByRole('alert');
    expect(alert.textContent).toContain('hover bar exploded');
    fail = false;
    act(() => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    });
    await settle(snowdrop);
    expect(snowdrop.plugins.get('message-tools')?.status).toBe('running');
    expect(within(card('Message Tools')).queryByRole('alert')).toBeNull();
    // S5: the Retry button is gone; focus lands on the card's switch.
    expect(document.activeElement).toBe(within(card('Message Tools')).getByRole('switch'));
  });

  it('filters by text, state and tag', async () => {
    snowdrop = await bootSnowdrop();
    const list = snowdrop.plugins.list();
    const names = (q: Parameters<typeof filterPlugins>[1]) =>
      filterPlugins(list, q).map((p) => p.definition.id);
    expect(names({ query: 'tracking', filter: 'all', tag: null })).toEqual(['clear-urls']);
    expect(names({ query: '', filter: 'all', tag: 'privacy' })).toEqual(['clear-urls']);
    expect(names({ query: '', filter: 'enabled', tag: null })).toContain('clear-urls');
    expect(names({ query: '', filter: 'disabled', tag: null })).not.toContain('clear-urls');
  });
});

const everything = definePlugin({
  id: 'form-demo',
  name: 'Form demo',
  description: 'Every setting type.',
  authors: ['test'],
  settings: defineSettings({
    on: { type: 'boolean', label: 'Flag', default: true },
    text: { type: 'string', label: 'Text', default: 'hi', maxLength: 5 },
    size: { type: 'number', label: 'Size', default: 4, min: 1, max: 10 },
    count: { type: 'number', label: 'Count', default: 2 },
    mode: {
      type: 'select',
      label: 'Mode',
      default: 'a',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    },
    pick: {
      type: 'select',
      label: 'Pick',
      default: 'w',
      options: ['w', 'x', 'y', 'z'].map((v) => ({ value: v, label: v.toUpperCase() })),
    },
  }),
  start() {},
});

describe('auto-generated plugin settings form', () => {
  it('renders the right control per type and saves coerced values', async () => {
    snowdrop = await bootSnowdrop();
    renderWithSnowdrop(snowdrop, <PluginSettingsForm plugin={everything} />);
    const stored = () => snowdrop!.stores.settings.getState().plugins['form-demo']?.settings ?? {};

    const flag = screen.getByRole('switch', { name: 'Flag' });
    expect(flag.getAttribute('aria-checked')).toBe('true');
    act(() => {
      fireEvent.click(flag);
    });
    expect(stored().on).toBe(false);

    act(() => {
      fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'toolong' } });
    });
    expect(stored().text).toBe('toolo');

    const slider = screen.getByLabelText('Size');
    expect(slider.getAttribute('type')).toBe('range');
    act(() => {
      fireEvent.change(slider, { target: { value: '8' } });
    });
    expect(stored().size).toBe(8);

    expect(screen.getByLabelText('Count').getAttribute('type')).toBe('number');

    // ≤ 3 options: segmented radios; more: a select.
    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    });
    expect(stored().mode).toBe('b');
    const select = screen.getByLabelText('Pick');
    expect(select.tagName).toBe('SELECT');
    act(() => {
      fireEvent.change(select, { target: { value: 'z' } });
    });
    expect(stored().pick).toBe('z');
    await settle(snowdrop);
  });
});
