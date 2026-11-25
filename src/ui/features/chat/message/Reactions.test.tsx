import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/ui/primitives';
import { Reactions } from './Reactions';

afterEach(cleanup);

const reaction = (emoji: string, authorId: string) => ({ emoji, authorId, at: 1 });

function Row({ reactions }: { reactions: { emoji: string; authorId: string; at: number }[] }) {
  return (
    <TooltipProvider>
      <div data-snowdrop="message" tabIndex={-1} aria-label="the row">
        <Reactions
          reactions={reactions}
          selfId="me"
          nameFor={(id) => id}
          onToggle={() => undefined}
          onAdd={() => undefined}
        />
      </div>
    </TooltipProvider>
  );
}

const pill = (emoji: string) => screen.getByRole('button', { name: new RegExp(`^${emoji}`, 'u') });

describe('a focused reaction pill that goes', () => {
  it('hands focus to the next pill, else the previous, else the message row (M15)', () => {
    const all = [reaction('👍', 'me'), reaction('😂', 'ana'), reaction('🎉', 'bo')];
    const { rerender } = render(<Row reactions={all} />);
    act(() => {
      pill('😂').focus();
    });
    rerender(<Row reactions={[all[0]!, all[2]!]} />);
    expect(document.activeElement).toBe(pill('🎉'));
    rerender(<Row reactions={[all[0]!]} />);
    expect(document.activeElement).toBe(pill('👍'));
    // The only pill: the row.
    rerender(<Row reactions={[]} />);
    expect(document.activeElement).toBe(screen.getByLabelText('the row'));
  });

  it('takes no focus the user put elsewhere', () => {
    const all = [reaction('👍', 'me'), reaction('😂', 'ana')];
    const { rerender } = render(
      <>
        <Row reactions={all} />
        <button type="button">elsewhere</button>
      </>,
    );
    act(() => {
      pill('👍').focus();
      screen.getByRole('button', { name: 'elsewhere' }).focus();
    });
    rerender(
      <>
        <Row reactions={[all[1]!]} />
        <button type="button">elsewhere</button>
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'elsewhere' }));
  });
});
