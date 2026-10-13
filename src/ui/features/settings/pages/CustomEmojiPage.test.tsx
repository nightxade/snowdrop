import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { Snowdrop } from '@/app/createSnowdrop';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { CustomEmojiPage } from './CustomEmojiPage';

let app: Snowdrop;
afterEach(async () => {
  cleanup();
  await app.dispose();
});

it('lists the collection and removes an emoji from it', async () => {
  app = await bootSnowdrop();
  app.stores.local
    .getState()
    .saveCustomEmoji({ kind: 'image', name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' });
  renderWithSnowdrop(app, <CustomEmojiPage />);

  expect(screen.getByText('1 of 32 used.')).toBeTruthy();
  expect(screen.getByText(':wave:')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Remove :wave:' }));
  expect(app.stores.local.getState().customEmoji).toEqual([]);
  expect(screen.getByText('No custom emoji yet — add one above.')).toBeTruthy();
});

it('explains invalid uploads without storing them', async () => {
  app = await bootSnowdrop();
  renderWithSnowdrop(app, <CustomEmojiPage />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'wave' } });
  await act(async () => {
    await Promise.resolve();
    fireEvent.change(screen.getByLabelText('Custom emoji image'), {
      target: { files: [new File(['text'], 'file.txt', { type: 'text/plain' })] },
    });
  });
  expect(screen.getByRole('status').textContent).toContain('PNG, JPEG, GIF or WebP');
  expect(app.stores.local.getState().customEmoji).toEqual([]);
});

it('switches to Text, adds a text emoticon and lists it by its text', async () => {
  app = await bootSnowdrop();
  renderWithSnowdrop(app, <CustomEmojiPage />);

  fireEvent.click(screen.getByRole('radio', { name: 'Text' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'shrug' } });
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: '¯\\_(ツ)_/¯' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add text emoji' }));

  expect(app.stores.local.getState().customEmoji).toEqual([
    { kind: 'text', name: 'shrug', text: '¯\\_(ツ)_/¯' },
  ]);
  expect(screen.getByText('¯\\_(ツ)_/¯')).toBeTruthy();
  expect(screen.getByText(':shrug:')).toBeTruthy();
});

it('rejects a name already used by another emoji in the collection', async () => {
  app = await bootSnowdrop();
  app.stores.local
    .getState()
    .saveCustomEmoji({ kind: 'image', name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' });
  renderWithSnowdrop(app, <CustomEmojiPage />);

  fireEvent.click(screen.getByRole('radio', { name: 'Text' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'wave' } });
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: ':)' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add text emoji' }));

  expect(screen.getByRole('status').textContent).toContain('already in your collection');
  expect(app.stores.local.getState().customEmoji).toHaveLength(1);
});
