import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import type * as AvatarLib from '../lib/profileAvatar';
import { ProfilePage } from './ProfilePage';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

vi.mock('../lib/profileAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof AvatarLib>()),
  prepareAvatar: vi.fn(() => Promise.resolve({ contentType: 'image/jpeg', base64: 'AAAA' })),
}));

let snowdrop: Snowdrop | null = null;

beforeEach(async () => {
  snowdrop = await bootSnowdrop();
});

afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
  vi.restoreAllMocks();
});

const input = (name: string) => screen.getByRole<HTMLInputElement>('textbox', { name });
const save = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Sav/u });
const self = () => snowdrop!.stores.session.getState().self!;
const type = (name: string, value: string) => {
  act(() => {
    fireEvent.change(input(name), { target: { value } });
  });
};

function open() {
  const view = renderWithSnowdrop(snowdrop!, <ProfilePage />);
  return view;
}

describe('Settings → Profile editor', () => {
  it('shows the current profile in editable fields, with no "use your phone" text', () => {
    open();
    expect(input('First name').value).toBe(self().profileGivenName ?? self().profileName);
    expect(input('Last name').value).toBe(self().profileFamilyName ?? '');
    expect(input('About').value).toBe(self().about ?? '');
    expect(screen.queryByText(/on your phone; Snowdrop picks/iu)).toBeNull();
    expect(save().disabled).toBe(true);
  });

  it('enables Save only for a real change, and needs a first name', () => {
    open();
    type('About', 'Out for a walk');
    expect(save().disabled).toBe(false);
    type('First name', '   ');
    expect(save().disabled).toBe(true);
    expect(screen.getByText('A first name is required.')).toBeTruthy();
    type('First name', 'Ada');
    expect(save().disabled).toBe(false);
  });

  it('saves the trimmed values, shows them at once and says so', async () => {
    const spy = vi.spyOn(snowdrop!.sync, 'updateProfile');
    open();
    type('First name', ' Ada ');
    type('Last name', 'Lovelace');
    type('About', 'Out for a walk');
    await act(async () => {
      fireEvent.click(save());
      await tick();
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({
      givenName: 'Ada',
      familyName: 'Lovelace',
      about: 'Out for a walk',
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Saved.');
    });
    expect(self()).toMatchObject({ profileName: 'Ada Lovelace', about: 'Out for a walk' });
    expect(save().disabled).toBe(true);
  });

  it('shows a saving state and locks the form while the save runs', async () => {
    let finish!: (message: string | null) => void;
    vi.spyOn(snowdrop!.sync, 'updateProfile').mockReturnValue(
      new Promise<string | null>((resolve) => {
        finish = resolve;
      }),
    );
    open();
    type('About', 'Hello');
    await act(async () => {
      fireEvent.click(save());
      await tick();
    });
    expect(save().textContent).toBe('Saving…');
    expect(save().disabled).toBe(true);
    expect(input('About').disabled).toBe(true);
    await act(async () => {
      finish(null);
      await tick();
    });
    expect(save().textContent).toBe('Save');
  });

  it('shows a failure inline and keeps what was typed', async () => {
    vi.spyOn(snowdrop!.sync, 'updateProfile').mockResolvedValue("Couldn't save your profile.");
    open();
    type('About', 'Hello');
    await act(async () => {
      fireEvent.click(save());
      await tick();
    });
    expect(screen.getByRole('alert').textContent).toBe("Couldn't save your profile.");
    expect(input('About').value).toBe('Hello');
    expect(save().disabled).toBe(false);
    // Editing again clears the message.
    type('About', 'Hello again');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("cuts text to Signal's limits and counts what is left", () => {
    open();
    type('First name', 'x'.repeat(40));
    expect(input('First name').value).toHaveLength(26);
    type('About', '🙂'.repeat(140));
    expect(input('About').value).toBe('🙂'.repeat(128));
    type('About', 'line one\nline two');
    expect(input('About').value).toBe('line oneline two');
    type('Last name', 'y'.repeat(20));
    expect(screen.getByText('6')).toBeTruthy();
  });

  it('drops the emoji when the about text is emptied, and offers one only with some text', () => {
    open();
    type('About', '');
    expect(screen.queryByRole('button', { name: 'Remove emoji' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add emoji' }).disabled).toBe(
      true,
    );
    type('About', 'Hello');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add emoji' }).disabled).toBe(
      false,
    );
  });

  it('removes the emoji on request and saves without it', async () => {
    const spy = vi.spyOn(snowdrop!.sync, 'updateProfile');
    open();
    type('About', 'Hello');
    // The demo profile starts with an emoji.
    fireEvent.click(screen.getByRole('button', { name: 'Remove emoji' }));
    await act(async () => {
      fireEvent.click(save());
      await tick();
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({ about: 'Hello', aboutEmoji: '' });
  });

  it('discards edits', () => {
    open();
    const before = input('About').value;
    type('About', 'something else');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(input('About').value).toBe(before);
    expect(save().disabled).toBe(true);
  });

  it('stages a new photo and a removal, and sends them with Save', async () => {
    const spy = vi.spyOn(snowdrop!.sync, 'updateProfile');
    const { container } = open();
    const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      fireEvent.change(file, {
        target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] },
      });
      await tick();
    });
    await waitFor(() => {
      expect(save().disabled).toBe(false);
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    await act(async () => {
      fireEvent.click(save());
      await tick();
    });
    expect(spy.mock.calls[0]![0].avatar).toEqual({ contentType: 'image/jpeg', base64: 'AAAA' });
    expect(self().avatarUrl).toBe('data:image/jpeg;base64,AAAA');

    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    expect(container.querySelector('img')).toBeNull();
    await act(async () => {
      fireEvent.click(save());
      await tick();
    });
    expect(spy.mock.calls[1]![0].avatar).toBeNull();
    expect(self().avatarUrl).toBeUndefined();
  });

  it('says so when the picked file is not an image it can read', async () => {
    const lib = await import('../lib/profileAvatar');
    vi.mocked(lib.prepareAvatar).mockRejectedValueOnce(new Error('bad'));
    const { container } = open();
    const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      fireEvent.change(file, { target: { files: [new File(['x'], 'a.txt')] } });
      await tick();
    });
    expect(screen.getByRole('alert').textContent).toMatch(/couldn't read that image/iu);
    expect(save().disabled).toBe(true);
  });

  it('has no axe violations while idle, edited, and failed', async () => {
    const { container } = open();
    expect((await axe(container)).violations).toEqual([]);
    type('About', 'Hello');
    expect((await axe(container)).violations).toEqual([]);
    vi.spyOn(snowdrop!.sync, 'updateProfile').mockResolvedValue("Couldn't save your profile.");
    await act(async () => {
      fireEvent.click(save());
      await tick();
    });
    expect((await axe(container)).violations).toEqual([]);
  });
});
