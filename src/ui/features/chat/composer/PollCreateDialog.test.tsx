import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { TooltipProvider } from '@/ui/primitives';
import { PollCreateDialog } from './PollCreateDialog';
import { emptyPollDraft, type PollDraft } from './pollDraft';

afterEach(cleanup);

const rules = { 'color-contrast': { enabled: false }, region: { enabled: false } };

function Harness(props: {
  onSend: (poll: { question: string; options: string[]; allowMultiple: boolean }) => void;
  onClose: () => void;
  initial?: PollDraft;
}) {
  const [draft, setDraft] = useState(props.initial ?? emptyPollDraft());
  return (
    <TooltipProvider>
      <PollCreateDialog
        draft={draft}
        onDraftChange={setDraft}
        onSend={props.onSend}
        onClose={props.onClose}
      />
    </TooltipProvider>
  );
}

function open(initial?: PollDraft) {
  const onSend = vi.fn();
  const onClose = vi.fn();
  render(<Harness onSend={onSend} onClose={onClose} {...(initial ? { initial } : {})} />);
  return { onSend, onClose };
}

const question = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Question' });
const options = () => screen.getAllByRole<HTMLInputElement>('textbox', { name: /^Option \d+$/u });
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
const type = (el: HTMLElement, value: string) => {
  fireEvent.change(el, { target: { value } });
};

describe('<PollCreateDialog />', () => {
  it('opens as "New poll" on the question, with two options and multiple votes allowed', () => {
    open();
    expect(screen.getByRole('dialog', { name: 'New poll' })).toBeTruthy();
    expect(document.activeElement).toBe(question());
    expect(question().placeholder).toBe('Ask a question');
    expect(options().map((o) => o.placeholder)).toEqual(['Option 1', 'Option 2']);
    expect(screen.getByRole('group', { name: 'Options' })).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Allow multiple votes' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps Send off until something is typed', () => {
    open();
    expect(send().disabled).toBe(true);
    type(options()[0]!, 'Pizza');
    expect(send().disabled).toBe(false);
  });

  it('grows a blank option as the last one is typed in, up to ten', () => {
    open();
    for (let i = 0; i < 12; i++) type(options().at(-1)!, `Option text ${i}`);
    expect(options()).toHaveLength(10);
    // At the limit the last row is simply edited again.
    expect(options()[0]?.value).toBe('');
    expect(options().at(-1)?.value).toBe('Option text 11');
  });

  it('removes an option you empty, and lands on the one that took its place', async () => {
    open();
    type(options()[0]!, 'a');
    type(options()[1]!, 'b');
    type(options()[2]!, 'c');
    expect(options()).toHaveLength(4);
    options()[1]!.focus();
    type(options()[1]!, '');
    expect(options().map((o) => o.value)).toEqual(['a', 'c', '']);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.activeElement).toBe(options()[1]);
  });

  it('removes an option with its own button, never below two', async () => {
    const user = userEvent.setup();
    open();
    type(options()[0]!, 'a');
    type(options()[1]!, 'b');
    expect(screen.getByRole('button', { name: 'Remove option 1' })).toBeTruthy();
    // With only two filled rows plus the spare, removing is possible; with exactly two rows it is not offered.
    await user.click(screen.getByRole('button', { name: 'Remove option 1' }));
    expect(options().map((o) => o.value)).toEqual(['b', '']);
    expect(screen.queryByRole('button', { name: /^Remove option/u })).toBeNull();
  });

  it('moves between fields with Enter', async () => {
    const user = userEvent.setup();
    open();
    await user.type(question(), 'Where?{Enter}');
    expect(document.activeElement).toBe(options()[0]);
    await user.keyboard('Pizza{Enter}');
    expect(document.activeElement).toBe(options()[1]);
  });

  it('cuts a question at 100 characters and an option at 100 UTF-16 units, and counts what is left', () => {
    open();
    type(question(), 'q'.repeat(150));
    expect(question().value).toHaveLength(100);
    expect(screen.getByText('0 characters left')).toBeTruthy();
    type(options()[0]!, '😀'.repeat(60));
    expect(options()[0]?.value).toBe('😀'.repeat(50));
  });

  it('shows how many characters are left only near the limit', () => {
    open();
    type(question(), 'q'.repeat(60));
    expect(screen.queryByText(/characters left/u)).toBeNull();
    type(question(), 'q'.repeat(80));
    expect(screen.getByText('20 characters left')).toBeTruthy();
  });

  it('says a question is missing and puts the cursor there', () => {
    const { onSend } = open();
    type(options()[0]!, 'a');
    type(options()[1]!, 'b');
    fireEvent.click(send());
    expect(screen.getByText('Poll question is required')).toBeTruthy();
    expect(question().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(question());
    expect(onSend).not.toHaveBeenCalled();
    // Typing clears the message.
    type(question(), 'Q?');
    expect(screen.queryByText('Poll question is required')).toBeNull();
  });

  it('says two options are needed, announces it, and goes to the first blank one', () => {
    const { onSend } = open();
    type(question(), 'Where?');
    type(options()[0]!, 'a');
    fireEvent.click(send());
    expect(screen.getByRole('alert').textContent).toBe('Poll requires at least 2 options');
    expect(document.activeElement).toBe(options()[1]);
    expect(options()[1]?.getAttribute('aria-invalid')).toBe('true');
    expect(options()[0]?.getAttribute('aria-invalid')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends the tidied poll, with the switch's choice", async () => {
    const user = userEvent.setup();
    const { onSend } = open();
    type(question(), '  Where to eat?  ');
    type(options()[0]!, ' Pizza ');
    type(options()[1]!, 'Ramen');
    await user.click(screen.getByRole('switch', { name: 'Allow multiple votes' }));
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith({
      question: 'Where to eat?',
      options: ['Pizza', 'Ramen'],
      allowMultiple: false,
    });
  });

  it('sends from any field with Ctrl+Enter', async () => {
    const user = userEvent.setup();
    const { onSend } = open();
    await user.type(question(), 'Where?');
    await user.type(options()[0]!, 'a');
    await user.type(options()[1]!, 'b');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('closes with Cancel and with Escape, without sending', async () => {
    const user = userEvent.setup();
    const { onClose, onSend } = open();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('starts from the draft it is given', () => {
    const initial = emptyPollDraft();
    open({ ...initial, question: 'Kept?', allowMultiple: false });
    expect(question().value).toBe('Kept?');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('has no axe violations when empty, filled, or showing an error', async () => {
    open();
    const dialog = screen.getByRole('dialog');
    expect((await axe(dialog, { rules })).violations.map((x) => x.id)).toEqual([]);
    type(question(), 'Where?');
    type(options()[0]!, 'a');
    expect((await axe(dialog, { rules })).violations.map((x) => x.id)).toEqual([]);
    fireEvent.click(send());
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expect((await axe(dialog, { rules })).violations.map((x) => x.id)).toEqual([]);
  });
});
