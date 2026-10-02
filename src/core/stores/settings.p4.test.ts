import { describe, expect, it } from 'vitest';
import { createMemoryStorage, loadVersioned } from '@/core/persistence';
import { settingsSchema } from './settings';

const load = (data: unknown, v = 2) => {
  const storage = createMemoryStorage();
  storage.setItem(settingsSchema.key, JSON.stringify({ v, data }));
  return loadVersioned(storage, settingsSchema);
};

describe('settings v3 migration (P4 review)', () => {
  it('renames quickCss to customCss', () => {
    expect(load({ quickCss: 'body{color:red}' }).customCss).toBe('body{color:red}');
  });

  it('turns an enabled Silent Typing plugin into sendTypingIndicators: false and drops it', () => {
    const s = load({
      plugins: { 'silent-typing': { enabled: true, settings: {} }, x: { settings: {} } },
    });
    expect(s.behaviour.sendTypingIndicators).toBe(false);
    expect(s.plugins).toEqual({ x: { settings: {} } });
  });

  it('a disabled or absent Silent Typing leaves typing indicators on', () => {
    expect(
      load({ plugins: { 'silent-typing': { enabled: false, settings: {} } } }).behaviour
        .sendTypingIndicators,
    ).toBe(true);
    expect(load({}).behaviour.sendTypingIndicators).toBe(true);
  });

  it('keeps v3 data as it is', () => {
    expect(load({ customCss: 'a{}', behaviour: { sendTypingIndicators: false } }, 3)).toMatchObject(
      {
        customCss: 'a{}',
        behaviour: { sendTypingIndicators: false },
      },
    );
  });
});
