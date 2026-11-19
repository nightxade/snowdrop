import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepFocusOnPage } from './keepFocusOnPage';

beforeEach(() => {
  // jsdom has no layout: everything counts as shown.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Row({ prompt = false }: { prompt?: boolean }) {
  const [reset, setReset] = useState(true);
  const [asking, setAsking] = useState(prompt);
  return (
    <div>
      <span>
        <button type="button" data-focus-anchor>
          Recorder
        </button>
        {reset && (
          <button
            type="button"
            onClick={() => {
              setReset(false);
            }}
          >
            Reset
          </button>
        )}
      </span>
      {asking && (
        <span>
          <button
            type="button"
            onClick={() => {
              setAsking(false);
            }}
          >
            Reassign
          </button>
          <button
            type="button"
            onClick={() => {
              setAsking(false);
            }}
          >
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}

function Field() {
  const [emoji, setEmoji] = useState(true);
  return (
    <div>
      <input aria-label="About" />
      {emoji && (
        <button
          type="button"
          onClick={() => {
            setEmoji(false);
          }}
        >
          Remove emoji
        </button>
      )}
      <button type="button">Emoji picker</button>
    </div>
  );
}

function Cards() {
  const [shown, setShown] = useState(['a', 'b', 'c']);
  return (
    <div>
      {shown.map((id) => (
        <article key={id}>
          <button type="button">{`${id} settings`}</button>
          <button
            type="button"
            role="switch"
            aria-checked="true"
            aria-label={`Disable ${id}`}
            onClick={() => {
              setShown((s) => s.filter((x) => x !== id));
            }}
          />
          <button type="button">{`${id} tag`}</button>
        </article>
      ))}
    </div>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div role="dialog" aria-label="Settings">
      <main ref={keepFocusOnPage}>{children}</main>
    </div>
  );
}

const press = (name: string | RegExp) => {
  const button = screen.getByRole(name instanceof RegExp ? 'switch' : 'button', { name });
  act(() => {
    button.focus();
  });
  act(() => {
    button.click();
  });
};

describe('a settings control that goes while it has focus', () => {
  it('hands focus to the recorder in its row when its reset goes', async () => {
    render(
      <Page>
        <Row />
      </Page>,
    );
    press('Reset');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Recorder' }));
    });
  });

  it('hands focus to the recorder, not the reset, when the conflict prompt closes', async () => {
    render(
      <Page>
        <Row prompt />
      </Page>,
    );
    press('Cancel');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Recorder' }));
    });
  });

  it('prefers the control of the same kind: Remove emoji goes to the picker, not the field', async () => {
    render(
      <Page>
        <Field />
      </Page>,
    );
    press('Remove emoji');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Emoji picker' }));
    });
  });

  it('a card filtered away hands focus to the neighbouring card, its switch', async () => {
    render(
      <Page>
        <Cards />
      </Page>,
    );
    press(/Disable b/);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Disable a' }));
    });
  });

  it('never takes focus the user put elsewhere', async () => {
    render(
      <>
        <button type="button">Outside</button>
        <Page>
          <Row />
        </Page>
      </>,
    );
    const reset = screen.getByRole('button', { name: 'Reset' });
    act(() => {
      reset.focus();
    });
    const outside = screen.getByRole('button', { name: 'Outside' });
    act(() => {
      outside.focus();
    });
    act(() => {
      reset.click();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(outside);
  });
});
