import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { CustomEmojiPanel } from './CustomEmojiPanel';

let app: Snowdrop;
afterEach(async () => {
  cleanup();
  await app.dispose();
});

it('searches, inserts :name: and removes a personal image emoji', async () => {
  app = await bootSnowdrop();
  app.stores.local
    .getState()
    .saveCustomEmoji({ kind: 'image', name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' });
  const select = vi.fn<(insert: string) => void>();
  renderWithSnowdrop(app, <CustomEmojiPanel onSelect={select} />);
  fireEvent.change(screen.getByLabelText('Find a custom emoji'), { target: { value: 'missing' } });
  expect(screen.getByText('No matching emoji.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Find a custom emoji'), { target: { value: 'wave' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert :wave:' }));
  expect(select).toHaveBeenCalledExactlyOnceWith(':wave: ');
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove :wave:' }));
  expect(app.stores.local.getState().customEmoji).toEqual([]);
});

it('explains invalid uploads without storing them', async () => {
  app = await bootSnowdrop();
  renderWithSnowdrop(app, <CustomEmojiPanel onSelect={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Custom emoji name'), { target: { value: 'wave' } });
  await act(async () => {
    await Promise.resolve();
    fireEvent.change(screen.getByLabelText('Custom emoji image'), {
      target: { files: [new File(['text'], 'file.txt', { type: 'text/plain' })] },
    });
  });
  expect(screen.getByRole('alert').textContent).toContain('PNG, JPEG, GIF or WebP');
  expect(app.stores.local.getState().customEmoji).toEqual([]);
});

it('adds a text emoticon, inserting its text directly rather than :name:', async () => {
  app = await bootSnowdrop();
  const select = vi.fn<(insert: string) => void>();
  renderWithSnowdrop(app, <CustomEmojiPanel onSelect={select} />);

  fireEvent.click(screen.getByRole('radio', { name: 'Text' }));
  fireEvent.change(screen.getByLabelText('Custom emoji name'), { target: { value: 'shrug' } });
  fireEvent.change(screen.getByLabelText('Emoticon text'), {
    target: { value: '¯\\_(ツ)_/¯' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add text' }));

  expect(app.stores.local.getState().customEmoji).toEqual([
    { kind: 'text', name: 'shrug', text: '¯\\_(ツ)_/¯' },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Insert ¯\\_(ツ)_/¯' }));
  expect(select).toHaveBeenCalledExactlyOnceWith('¯\\_(ツ)_/¯ ');
});

it('explains an invalid text emoticon without storing it', async () => {
  app = await bootSnowdrop();
  renderWithSnowdrop(app, <CustomEmojiPanel onSelect={vi.fn()} />);
  fireEvent.click(screen.getByRole('radio', { name: 'Text' }));
  fireEvent.change(screen.getByLabelText('Custom emoji name'), { target: { value: 'blank' } });
  fireEvent.change(screen.getByLabelText('Emoticon text'), { target: { value: '   ' } });
  // The empty-after-trim text leaves the button disabled rather than throwing.
  expect(screen.getByRole('button', { name: 'Add text' }).hasAttribute('disabled')).toBe(true);
  expect(app.stores.local.getState().customEmoji).toEqual([]);
});
