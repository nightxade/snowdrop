import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { SafeModeHint } from './SafeModeHint';

const snowdrops: Snowdrop[] = [];
afterEach(async () => {
  cleanup();
  for (const s of snowdrops.splice(0)) await s.dispose();
});

async function hint(desktop: boolean): Promise<string> {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const app = { ...snowdrop, desktop: desktop ? ({} as NonNullable<Snowdrop['desktop']>) : null };
  const { container } = renderWithSnowdrop(
    app,
    <p>
      <SafeModeHint cause="one" without="your themes" />
    </p>,
  );
  return container.textContent;
}

describe('SafeModeHint', () => {
  it('tells the desktop app to start with --safe, never to hold Shift', async () => {
    const text = await hint(true);
    expect(text).toContain('snowdrop --safe');
    expect(text).not.toMatch(/shift|\?safe=1/iu);
  });

  it('tells the browser build to add ?safe=1', async () => {
    const text = await hint(false);
    expect(text).toContain('?safe=1');
    expect(text).not.toMatch(/shift|--safe/iu);
  });
});
