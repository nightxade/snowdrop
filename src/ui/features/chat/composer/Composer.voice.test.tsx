import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Snowdrop } from '@/app/createSnowdrop';
import type { ConversationId } from '@/core/domain';
import { messagesSelectors } from '@/core/stores';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { ChatController, ChatControllerProvider } from '../ChatController';
import { rig, type Rig } from '../voice/fakeRecorder';
import { Composer } from './Composer';

// The real microphone, audio graph and encoder never run here: one fake rig stands in for all three.
const fake = vi.hoisted(() => ({ current: null as Rig | null }));
vi.mock('../voice/webAudioCapture', () => ({
  openMicrophone: () => fake.current?.deps.openStream(),
  createWebAudioCapture: () => fake.current?.deps.createCapture(),
}));
vi.mock('../voice/mp3Encoder', () => ({
  createMp3Encoder: (rate: number) => fake.current?.deps.createEncoder(rate),
}));

const snowdrops: Snowdrop[] = [];
beforeEach(() => {
  fake.current = rig();
});
afterEach(async () => {
  cleanup();
  for (const h of snowdrops.splice(0)) await h.dispose();
});

async function setup() {
  const snowdrop = await bootSnowdrop();
  snowdrops.push(snowdrop);
  const conv = Object.values(snowdrop.stores.conversations.getState().byId).find(
    (c) => c.title === 'Orchard · Engineering',
  )!;
  await act(async () => {
    snowdrop.stores.ui.getState().selectConversation(conv.id);
    await snowdrop.history.open(conv.id);
  });
  const chat = new ChatController();
  const view = renderWithSnowdrop(
    snowdrop,
    <ChatControllerProvider value={chat}>
      <Composer conversationId={conv.id} />
    </ChatControllerProvider>,
  );
  return { snowdrop, conv, chat, view };
}

const record = () => screen.getByRole('button', { name: 'Record a voice message' });
const stopped = () => fake.current!.tracks.every((t) => t.stop.mock.calls.length > 0);

async function startRecording() {
  await act(async () => {
    fireEvent.click(record());
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(screen.getByRole('button', { name: 'Send voice message' })).toHaveProperty(
      'disabled',
      false,
    );
  });
}

function lastOwn(snowdrop: Snowdrop, id: ConversationId) {
  const selfId = snowdrop.stores.session.getState().self!.id;
  return messagesSelectors
    .list(id)(snowdrop.stores.messages.getState())
    .findLast((m) => m.authorId === selfId);
}

describe('<Composer /> voice notes', () => {
  it('offers the microphone only while there is nothing to send', async () => {
    await setup();
    expect(record()).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    expect(record()).toBeTruthy();
  });

  it('records, shows the timer and the one-hour note, and sends a flagged MP3', async () => {
    const { snowdrop, conv } = await setup();
    await startRecording();
    expect(screen.getByRole('group', { name: 'Voice message recorder' })).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toBe('0:00');
    expect(screen.getByText(/limited to one hour/u)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Voice message recorder');
    act(() => {
      fake.current!.capture.deliver(new Float32Array(4096).fill(0.3));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(lastOwn(snowdrop, conv.id)?.attachments[0]?.voiceNote).toBe(true);
    });
    const attachment = lastOwn(snowdrop, conv.id)!.attachments[0]!;
    expect(attachment).toMatchObject({ contentType: 'audio/mpeg', fileName: 'voice-note.mp3' });
    expect(stopped()).toBe(true);
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('Cancel and Escape discard the recording and turn the microphone off', async () => {
    const { snowdrop, conv } = await setup();
    await startRecording();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(stopped()).toBe(true);
    expect(screen.getByRole('textbox')).toBeTruthy();

    fake.current = rig();
    await startRecording();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(stopped()).toBe(true);
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(lastOwn(snowdrop, conv.id)?.attachments ?? []).toHaveLength(0);
  });

  it('switching away from the window keeps the recording as a draft to listen to, send or drop', async () => {
    const { snowdrop, conv } = await setup();
    await startRecording();
    act(() => {
      fake.current!.capture.deliver(new Float32Array(4096).fill(0.3));
      window.dispatchEvent(new Event('blur'));
    });
    await screen.findByRole('button', { name: 'Play voice message' });
    expect(stopped()).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();

    // Drop it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play voice message' })).toBeNull();

    // Again, and send it.
    fake.current = rig();
    await startRecording();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await screen.findByRole('button', { name: 'Play voice message' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(lastOwn(snowdrop, conv.id)?.attachments[0]?.voiceNote).toBe(true);
    });
  });

  it('says why when the microphone is refused, and when there is none', async () => {
    await setup();
    fake.current!.deps.openStream = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
    await act(async () => {
      fireEvent.click(record());
      await Promise.resolve();
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/can't use the microphone/u);
    expect(screen.getByRole('textbox')).toBeTruthy();

    fake.current!.deps.openStream = () => Promise.reject(new DOMException('none', 'NotFoundError'));
    await act(async () => {
      fireEvent.click(record());
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/No microphone found/u);
    });
  });

  it('turns the microphone off when the conversation changes (the composer goes away)', async () => {
    const { view } = await setup();
    await startRecording();
    view.unmount();
    expect(stopped()).toBe(true);
    expect(fake.current!.capture.closed).toBe(1);
  });

  it('starts from the command only when the composer is empty, and keeps a voice message alone', async () => {
    const { chat } = await setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typing' } });
    act(() => {
      chat.startVoiceNote();
    });
    expect(screen.queryByRole('group', { name: 'Voice message recorder' })).toBeNull();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    await act(async () => {
      chat.startVoiceNote();
      await Promise.resolve();
    });
    await screen.findByRole('group', { name: 'Voice message recorder' });
    // A file dropped meanwhile is refused.
    act(() => {
      chat.addFiles([new File(['x'], 'x.txt', { type: 'text/plain' })]);
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A voice message must have only one attachment.',
    );
  });

  it('refuses a file next to a voice draft, and the command next to a file', async () => {
    const { chat } = await setup();
    act(() => {
      chat.addFiles([new File(['x'], 'x.txt', { type: 'text/plain' })]);
    });
    expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
    act(() => {
      chat.startVoiceNote();
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'A voice message must have only one attachment.',
    );
  });

  it('has no axe violations while recording or with a draft', async () => {
    const { view } = await setup();
    await startRecording();
    const rules = { region: { enabled: false } };
    expect((await axe(view.container, { rules })).violations.map((v) => v.id)).toEqual([]);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await screen.findByRole('button', { name: 'Play voice message' });
    expect((await axe(view.container, { rules })).violations.map((v) => v.id)).toEqual([]);
  });
});
