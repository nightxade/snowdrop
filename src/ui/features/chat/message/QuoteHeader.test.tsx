import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { QuoteHeader } from './QuoteHeader';

let app: Snowdrop | undefined;
afterEach(async () => {
  cleanup();
  await app?.dispose();
  app = undefined;
});

describe('<QuoteHeader />', () => {
  it('never reveals a spoiler in the quoted text', async () => {
    app = await bootSnowdrop();
    renderWithSnowdrop(
      app,
      <QuoteHeader
        quote={{
          authorId: 'someone',
          sentAt: 1,
          text: 'the end: he dies',
          ranges: [{ start: 9, length: 7, style: 'spoiler' }],
        }}
        nameFor={() => ''}
        onJump={() => undefined}
      />,
    );
    expect(screen.getByText('the end: ▒▒▒▒')).toBeTruthy();
    expect(screen.queryByText(/he dies/u)).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toMatch(/he dies/u);
  });
});
