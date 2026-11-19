import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Switch } from './Switch';

afterEach(cleanup);

describe('Button', () => {
  it('runs its click handler', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('while busy, ignores activation but is not disabled, so a focused button keeps focus', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    button.focus();
    rerender(
      <Button busy onClick={onClick}>
        Save
      </Button>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<Button onClick={onClick}>Save</Button>);
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('aria-busy')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('while busy, does not submit its form', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" busy>
          Save
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disabled while it has focus: keeps focus, ignores activation, and goes disabled once focus leaves', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <>
        <Button onClick={onClick}>Reset</Button>
        <Button>Other</Button>
      </>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Reset' });
    act(() => {
      button.focus();
    });
    rerender(
      <>
        <Button disabled onClick={onClick}>
          Reset
        </Button>
        <Button>Other</Button>
      </>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    act(() => {
      screen.getByRole<HTMLButtonElement>('button', { name: 'Other' }).focus();
    });
    expect(button.disabled).toBe(true);
  });

  it('disabled without focus is disabled as ever, and a focused enabled one is unaffected', () => {
    render(<Button disabled>Reset</Button>);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Reset' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });

  it('a Switch that goes inert while focused keeps focus and ignores a toggle', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Switch checked={false} onCheckedChange={onChange} ariaLabel="Receipts" />,
    );
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: 'Receipts' });
    act(() => {
      toggle.focus();
    });
    rerender(<Switch checked disabled onCheckedChange={onChange} ariaLabel="Receipts" />);
    expect(toggle.disabled).toBe(false);
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});
