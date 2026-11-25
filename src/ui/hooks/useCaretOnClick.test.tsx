import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useCaretOnClick } from './useCaretOnClick';

afterEach(cleanup);

function mouseUp(target: Element) {
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

describe('useCaretOnClick', () => {
  it('puts the caret at the end of a clicked field left without a selection', () => {
    renderHook(() => {
      useCaretOnClick();
    });
    const { getByRole } = render(<textarea defaultValue="draft" />);
    const field = getByRole('textbox') as HTMLTextAreaElement;
    // As WebKitGTK leaves it after a zoomed click: the field focused, no selection anywhere.
    field.focus();
    field.setSelectionRange(0, 0);
    document.getSelection()?.removeAllRanges();
    mouseUp(field);
    expect(field.selectionStart).toBe(5);
    expect(field.selectionEnd).toBe(5);
  });

  it('leaves a field alone when the click left a selection', () => {
    renderHook(() => {
      useCaretOnClick();
    });
    const { getByRole } = render(<input defaultValue="query" />);
    const field = getByRole('textbox') as HTMLInputElement;
    field.focus();
    field.setSelectionRange(2, 2);
    const range = document.createRange();
    range.selectNodeContents(document.body);
    document.getSelection()?.addRange(range);
    mouseUp(field);
    expect(field.selectionStart).toBe(2);
  });

  it('does nothing for a click outside the focused field, or after unmount', () => {
    const { unmount } = renderHook(() => {
      useCaretOnClick();
    });
    const { getByRole, getByText } = render(
      <div>
        <textarea defaultValue="draft" />
        <button type="button">elsewhere</button>
      </div>,
    );
    const field = getByRole('textbox') as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(1, 1);
    document.getSelection()?.removeAllRanges();
    mouseUp(getByText('elsewhere'));
    expect(field.selectionStart).toBe(1);
    unmount();
    mouseUp(field);
    expect(field.selectionStart).toBe(1);
  });
});
