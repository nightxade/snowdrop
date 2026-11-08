import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryKeyReveal } from './RecoveryKeyReveal';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const code = 'ABCD-EFGH-JKLM-NPQR';
const copy = async () => {
  render(<RecoveryKeyReveal code={code} onConfirmed={() => undefined} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe('RecoveryKeyReveal copy', () => {
  it('confirms a copy that worked', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.resolve() } });
    await copy();
    expect(screen.getByRole('status').textContent).toContain('Copied.');
  });

  it('says so when the clipboard refuses, instead of staying silent', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('no')) } });
    await copy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t copy');
  });
});
