import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarRef } from '@/core/domain';
import { FakeIO, installFakeIO } from '@/test/fakeIntersectionObserver';
import { SnowdropContextProvider, type AppServices } from './SnowdropContext';
import { useAvatarSrc, type AvatarSrcOptions } from './useAvatarSrc';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const URL_A = 'data:image/jpeg;base64,AAAA';

type Backend = Pick<AppServices['backend'], 'resolveAvatarUrl' | 'peekAvatarUrl'>;

/** A backend that answers from `answers`, remembers like the real one, and counts its asks. */
function fakeBackend(answers: Record<string, string | null>) {
  const known = new Map<string, string | null>();
  const resolve = vi.fn((ref: AvatarRef) => {
    const value = answers[ref.id] ?? null;
    known.set(ref.id, value);
    return Promise.resolve(value);
  });
  const backend: Backend = {
    resolveAvatarUrl: resolve,
    peekAvatarUrl: (ref) => known.get(ref.id),
  };
  return { backend, resolve, known };
}

function Probe({
  id,
  kind = 'contact',
  options,
}: {
  id: string | null;
  kind?: AvatarRef['kind'];
  options?: AvatarSrcOptions;
}) {
  const [ref, src] = useAvatarSrc(kind, id, options);
  return <span ref={ref} data-testid="probe" data-src={src ?? ''} />;
}

function renderProbe(backend: Backend, ui: React.ReactElement) {
  return render(
    <SnowdropContextProvider value={{ backend } as unknown as AppServices}>
      {ui}
    </SnowdropContextProvider>,
  );
}

const src = () => screen.getByTestId('probe').dataset['src'];

/** The avatar has scrolled into view (happy-dom's own observer never reports anything). */
async function scrollIntoView(): Promise<void> {
  await act(async () => {
    FakeIO.instances.at(-1)?.emit(true);
    await Promise.resolve();
  });
}

describe('useAvatarSrc', () => {
  beforeEach(installFakeIO);

  it("fetches an avatar's picture and shows it", async () => {
    const { backend, resolve } = fakeBackend({ ana: URL_A });
    renderProbe(backend, <Probe id="ana" />);
    expect(src()).toBe('');
    await scrollIntoView();
    expect(src()).toBe(URL_A);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ kind: 'contact', id: 'ana' });
  });

  it('asks for a group by its conversation id', async () => {
    const { backend, resolve } = fakeBackend({});
    renderProbe(backend, <Probe kind="group" id="group:xyz" />);
    await scrollIntoView();
    expect(resolve).toHaveBeenCalledWith({ kind: 'group', id: 'group:xyz' });
  });

  describe('only for avatars on screen', () => {
    it('waits until the avatar scrolls into view, and then asks once', async () => {
      const { backend, resolve } = fakeBackend({ ana: URL_A });
      renderProbe(backend, <Probe id="ana" />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(FakeIO.instances[0]?.observed.has(screen.getByTestId('probe'))).toBe(true);
      await act(async () => {
        FakeIO.instances[0]?.emit(true);
        await Promise.resolve();
      });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(src()).toBe(URL_A);
      expect(FakeIO.instances[0]?.disconnected).toBe(true);
    });

    it('never asks for one that stays off screen', async () => {
      const { backend, resolve } = fakeBackend({ ana: URL_A });
      renderProbe(backend, <Probe id="ana" />);
      await act(async () => {
        FakeIO.instances[0]?.emit(false);
        await Promise.resolve();
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(src()).toBe('');
    });

    it('fills a row that remounts on its first frame, without asking again', () => {
      const { backend, resolve, known } = fakeBackend({ ana: URL_A });
      known.set('ana', URL_A);
      renderProbe(backend, <Probe id="ana" />);
      expect(src()).toBe(URL_A);
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it('shows the fallback while loading and for someone with no picture', async () => {
    const { backend } = fakeBackend({});
    renderProbe(backend, <Probe id="ana" options={{ known: 'data:image/png;base64,KNOWN' }} />);
    expect(src()).toBe('data:image/png;base64,KNOWN');
    await scrollIntoView();
    expect(src()).toBe('data:image/png;base64,KNOWN');
  });

  it('fetches and shows nothing for a held (not yet accepted) picture', async () => {
    const { backend, resolve, known } = fakeBackend({ ana: URL_A });
    known.set('ana', URL_A);
    renderProbe(backend, <Probe id="ana" options={{ held: true, known: 'data:x' }} />);
    await scrollIntoView();
    expect(resolve).not.toHaveBeenCalled();
    expect(src()).toBe('');
  });

  it('starts fetching when a held picture is let through', async () => {
    const { backend, resolve } = fakeBackend({ ana: URL_A });
    const view = renderProbe(backend, <Probe id="ana" options={{ held: true }} />);
    await scrollIntoView();
    expect(resolve).not.toHaveBeenCalled();
    view.rerender(
      <SnowdropContextProvider value={{ backend } as unknown as AppServices}>
        <Probe id="ana" options={{ held: false }} />
      </SnowdropContextProvider>,
    );
    await scrollIntoView();
    expect(src()).toBe(URL_A);
  });

  it('asks for nothing without an id, and falls back for a backend with no avatars', async () => {
    const { backend, resolve } = fakeBackend({});
    renderProbe(backend, <Probe id={null} />);
    renderProbe({}, <Probe id="ana" options={{ known: 'data:k' }} />);
    await scrollIntoView();
    expect(resolve).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('probe')[1]?.dataset['src']).toBe('data:k');
  });

  it('shows the fallback, and does not retry in a loop, when the daemon is unreachable', async () => {
    const resolve = vi.fn(() => Promise.reject(new Error('down')));
    renderProbe(
      { resolveAvatarUrl: resolve, peekAvatarUrl: () => undefined },
      <Probe id="ana" options={{ known: 'data:k' }} />,
    );
    await scrollIntoView();
    await act(async () => {
      await Promise.resolve();
    });
    expect(src()).toBe('data:k');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('asks again when the picture may have changed (a new version) and the cache was dropped', async () => {
    const { backend, resolve, known } = fakeBackend({ ana: URL_A });
    const wrap = (version: number) => (
      <SnowdropContextProvider value={{ backend } as unknown as AppServices}>
        <Probe id="ana" options={{ version }} />
      </SnowdropContextProvider>
    );
    const view = render(wrap(1));
    await scrollIntoView();
    expect(resolve).toHaveBeenCalledTimes(1);
    known.delete('ana'); // what the backend does when it learns of the change
    view.rerender(wrap(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
