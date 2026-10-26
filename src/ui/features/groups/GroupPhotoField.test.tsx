import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationIdFor } from '@/core/domain/testing';
import { FakeIO, installFakeIO } from '@/test/fakeIntersectionObserver';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { GroupPhotoField } from './GroupPhotoField';

const STORED = 'data:image/jpeg;base64,STORED';
const group = conversationIdFor('club');

beforeEach(installFakeIO);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderField(props: Partial<React.ComponentProps<typeof GroupPhotoField>> = {}) {
  const resolve = vi.fn(() => Promise.resolve(STORED));
  const value = {
    backend: { resolveAvatarUrl: resolve, peekAvatarUrl: () => undefined },
  } as unknown as AppServices;
  const view = render(
    <SnowdropContextProvider value={value}>
      <GroupPhotoField
        name="Club"
        color="tomato"
        groupId={group}
        staged={null}
        onStage={vi.fn()}
        onProblem={vi.fn()}
        {...props}
      />
    </SnowdropContextProvider>,
  );
  return { ...view, resolve };
}

const shown = (container: HTMLElement) => container.querySelector('img')?.getAttribute('src');

describe('<GroupPhotoField />', () => {
  it("shows the group's stored photo when editing, so it is still there after a restart", async () => {
    const { container, resolve, getByRole } = renderField();
    await act(async () => {
      for (const io of FakeIO.instances) io.emit(true);
      await Promise.resolve();
    });
    expect(resolve).toHaveBeenCalledWith({ kind: 'group', id: group });
    expect(shown(container)).toBe(STORED);
    expect(getByRole('button', { name: 'Change photo' })).toBeTruthy();
  });

  it('shows a newly picked photo over the stored one', async () => {
    const staged = { dataUri: 'data:image/jpeg;base64,PICKED' };
    const { container } = renderField({ staged });
    await act(async () => {
      for (const io of FakeIO.instances) io.emit(true);
      await Promise.resolve();
    });
    expect(shown(container)).toBe(staged.dataUri);
  });

  it('is initials and "Add photo" for a new group, and asks the backend for nothing', () => {
    const { container, resolve, getByRole } = renderField({ groupId: undefined });
    expect(shown(container)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(getByRole('button', { name: 'Add photo' })).toBeTruthy();
  });
});
