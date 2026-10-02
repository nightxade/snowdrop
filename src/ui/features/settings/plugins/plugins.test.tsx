import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin, defineSettings } from '@/core/plugins';
import { bootShrike, renderWithShrike, settle } from '@/test/renderWithShrike';
import type { Shrike } from '@/app/createShrike';
import { PluginSettingsForm } from './PluginSettingsForm';
import { PluginsPage } from './PluginsPage';
import { filterPlugins } from './usePlugins';

let shrike: Shrike | null = null;
afterEach(async () => {
  cleanup();
  await shrike?.dispose();
  shrike = null;
});

const card = (name: string) =>
  screen.getByRole('heading', { name }).closest('article') as HTMLElement;

describe('Plugins page', () => {
  it('starts and stops a plugin live from its card', async () => {
    shrike = await bootShrike();
    renderWithShrike(shrike, <PluginsPage />);
    const decorations = () => shrike!.registries.messageDecorations.list().map((d) => d.id);
    expect(decorations()).not.toContain('relative-time');

    const toggle = within(card('Relative Timestamps')).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => {
      fireEvent.click(toggle);
    });
    await settle(shrike);
    expect(shrike.plugins.get('relative-timestamps')).toMatchObject({
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
    await settle(shrike);
    expect(shrike.plugins.get('relative-timestamps')?.status).toBe('stopped');
    expect(decorations()).not.toContain('relative-time');
  });

  it('opens the generated settings form from the cog', async () => {
    shrike = await bootShrike();
    renderWithShrike(shrike, <PluginsPage />);
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
    expect(shrike.stores.settings.getState().plugins['keyword-alerts']?.settings.keywords).toBe(
      'deploy, lunch',
    );
  });

  it('shows a failed plugin with its error and retries', async () => {
    shrike = await bootShrike();
    renderWithShrike(shrike, <PluginsPage />);
    // Silent Typing registers a typing guard; make that blow up once.
    const original = shrike.registries.typingGuards.add.bind(shrike.registries.typingGuards);
    let fail = true;
    shrike.registries.typingGuards.add = (entry) => {
      if (fail) throw new Error('guard exploded');
      return original(entry);
    };
    act(() => {
      fireEvent.click(within(card('Silent Typing')).getByRole('switch'));
    });
    await settle(shrike);
    const alert = within(card('Silent Typing')).getByRole('alert');
    expect(alert.textContent).toContain('guard exploded');
    fail = false;
    act(() => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    });
    await settle(shrike);
    expect(shrike.plugins.get('silent-typing')?.status).toBe('running');
    expect(within(card('Silent Typing')).queryByRole('alert')).toBeNull();
  });

  it('filters by text, state and tag', async () => {
    shrike = await bootShrike();
    const list = shrike.plugins.list();
    const names = (q: Parameters<typeof filterPlugins>[1]) =>
      filterPlugins(list, q).map((p) => p.definition.id);
    expect(names({ query: 'tracking', filter: 'all', tag: null })).toEqual(['clear-urls']);
    expect(names({ query: '', filter: 'all', tag: 'privacy' })).toEqual([
      'clear-urls',
      'silent-typing',
    ]);
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
    shrike = await bootShrike();
    renderWithShrike(shrike, <PluginSettingsForm plugin={everything} />);
    const stored = () => shrike!.stores.settings.getState().plugins['form-demo']?.settings ?? {};

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
    await settle(shrike);
  });
});
