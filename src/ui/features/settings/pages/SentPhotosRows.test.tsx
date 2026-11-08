/**
 * Settings → Data & storage: the readout of full-quality sent photos and the
 * "Free up space" flow (choose an age, confirm, see the result).
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import { mergeOutgoingCommit, type Message } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { DataPage } from './DataPage';

const conversationId = conversationIdFor('photos');
const DAY = 24 * 60 * 60 * 1000;

let snowdrop: Snowdrop | null = null;
afterEach(async () => {
  cleanup();
  await snowdrop?.dispose();
  snowdrop = null;
});

async function keep(app: Snowdrop, id: string, daysAgo: number): Promise<Message> {
  const message = makeMessage({
    conversationId,
    authorId: 'me',
    sentAt: Date.now() - daysAgo * DAY,
    status: 'sent',
    attachments: [{ id, contentType: 'image/png', original: true }],
  });
  await app.repository.commitOutgoing('n', message, mergeOutgoingCommit, [
    { id, data: new Blob([new Uint8Array(16)]) },
  ]);
  return message;
}

const readout = () =>
  document.querySelector('[data-setting="data.sentPhotos"] p')?.textContent ?? null;

async function open(app: Snowdrop) {
  await act(async () => {
    renderWithSnowdrop(app, <DataPage />);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const choose = (label: string) => {
  fireEvent.change(screen.getByRole('combobox', { name: 'Photos to free up' }), {
    target: { value: label },
  });
};

const freeUp = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Free up…' }));
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe('Full-quality sent photos readout', () => {
  it('says None when there are none, and disables Free up', async () => {
    snowdrop = await bootSnowdrop();
    await open(snowdrop);
    await waitFor(() => {
      expect(readout()).toBe('None');
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Free up…' }).disabled).toBe(true);
  });

  it('shows the space they use, measured when the page opens', async () => {
    snowdrop = await bootSnowdrop();
    await keep(snowdrop, 'local:1', 5);
    await keep(snowdrop, 'local:2', 400);
    await open(snowdrop);
    await waitFor(() => {
      expect(readout()).toBe('32 B');
    });
    expect(screen.getByText('Full-quality sent photos')).toBeTruthy();
  });
});

describe('Free up space', () => {
  it('asks first, and removes nothing when cancelled', async () => {
    snowdrop = await bootSnowdrop();
    await keep(snowdrop, 'local:old', 400);
    await open(snowdrop);
    await waitFor(() => {
      expect(readout()).toBe('16 B');
    });
    choose('1y');
    await freeUp();

    const dialog = await screen.findByRole('dialog', { name: 'Free up 16 B?' });
    expect(dialog.textContent).toContain('1 photo');
    expect(dialog.textContent).toContain('preview quality');
    expect(dialog.textContent).toContain('more than a year ago');
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect((await axe(dialog, { rules: { region: { enabled: false } } })).violations).toEqual([]);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await snowdrop.repository.readSentMedia('local:old', 'image/png')).toBeDefined();
    expect(readout()).toBe('16 B');
  });

  it('removes only the older photos on confirm, shows the result, and updates the readout and loaded messages', async () => {
    snowdrop = await bootSnowdrop();
    const old = await keep(snowdrop, 'local:old', 100);
    const recent = await keep(snowdrop, 'local:new', 2);
    snowdrop.stores.messages
      .getState()
      .replaceWindow(conversationId, [old, recent], { hasMoreBefore: false, hasMoreAfter: false });
    await open(snowdrop);
    await waitFor(() => {
      expect(readout()).toBe('32 B');
    });
    choose('30d');
    await freeUp();
    await screen.findByRole('dialog', { name: 'Free up 16 B?' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Free up space' }));
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => {
      expect(screen.getByText('Freed 16 B from 1 photo.')).toBeTruthy();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(readout()).toBe('16 B');
    });
    expect(await snowdrop.repository.readSentMedia('local:old', 'image/png')).toBeUndefined();
    expect(await snowdrop.repository.readSentMedia('local:new', 'image/png')).toBeDefined();
    // The messages already on screen fall back to the preview too.
    const window = snowdrop.stores.messages.getState().windows[conversationId];
    expect(window?.byId[old.id]?.attachments[0]?.original).toBeUndefined();
    expect(window?.byId[recent.id]?.attachments[0]?.original).toBe(true);
    expect(
      (await axe(document.body, { rules: { region: { enabled: false } } })).violations,
    ).toEqual([]);
  });

  it('says so, without a dialog, when nothing is that old', async () => {
    snowdrop = await bootSnowdrop();
    await keep(snowdrop, 'local:new', 2);
    await open(snowdrop);
    await waitFor(() => {
      expect(readout()).toBe('16 B');
    });
    choose('30d');
    await freeUp();
    await waitFor(() => {
      expect(screen.getByText('None older than 30 days.')).toBeTruthy();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await snowdrop.repository.readSentMedia('local:new', 'image/png')).toBeDefined();
  });

  it('can free all of them', async () => {
    snowdrop = await bootSnowdrop();
    await keep(snowdrop, 'local:1', 1);
    await keep(snowdrop, 'local:2', 0);
    await open(snowdrop);
    await waitFor(() => {
      expect(readout()).toBe('32 B');
    });
    choose('all');
    await freeUp();
    await screen.findByRole('dialog', { name: 'Free up 32 B?' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Free up space' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(screen.getByText('Freed 32 B from 2 photos.')).toBeTruthy();
    });
    await waitFor(() => {
      expect(readout()).toBe('None');
    });
  });

  it('shows the error when removing fails, and can be tried again', async () => {
    snowdrop = await bootSnowdrop();
    await keep(snowdrop, 'local:old', 100);
    await open(snowdrop);
    await waitFor(() => {
      expect(readout()).toBe('16 B');
    });
    vi.spyOn(snowdrop.admin, 'dropSentOriginals').mockRejectedValueOnce(new Error('disk full'));
    await freeUp();
    await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Free up space' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(screen.getByText(/Couldn’t free up space: disk full/u)).toBeTruthy();
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Free up…' }).disabled).toBe(
      false,
    );
  });
});
