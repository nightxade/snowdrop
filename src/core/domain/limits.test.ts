import { describe, expect, it } from 'vitest';
import {
  attachmentProblem,
  attachmentProblemMessage,
  MAX_ATTACHMENT_BYTES,
  rejectedFilesMessage,
} from './limits';

describe('attachmentProblem', () => {
  it('allows exactly the limit and refuses one byte more', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
    expect(attachmentProblem({ size: MAX_ATTACHMENT_BYTES })).toBeNull();
    expect(attachmentProblem({ size: MAX_ATTACHMENT_BYTES + 1 })).toBe('too-large');
  });

  it('calls zero bytes empty and one byte fine', () => {
    expect(attachmentProblem({ size: 0 })).toBe('empty');
    expect(attachmentProblem({ size: 1 })).toBeNull();
  });
});

describe('the sentences', () => {
  it('names one file', () => {
    expect(attachmentProblemMessage('a.mov', 'too-large')).toBe(
      '“a.mov” is over 100 MB, so it can’t be sent.',
    );
    expect(attachmentProblemMessage('a.txt', 'empty')).toBe('“a.txt” is empty.');
    expect(attachmentProblemMessage('', 'empty')).toBe('This file is empty.');
  });

  it('lists up to three names and counts more', () => {
    const r = (name: string) => ({ name, problem: 'too-large' as const });
    expect(rejectedFilesMessage([r('a'), r('b')])).toBe(
      '“a” and “b” are over 100 MB, so they can’t be sent.',
    );
    expect(rejectedFilesMessage([r('a'), r('b'), r('c')])).toBe(
      '“a”, “b” and “c” are over 100 MB, so they can’t be sent.',
    );
    expect(rejectedFilesMessage(['a', 'b', 'c', 'd'].map(r))).toBe(
      '4 files are over 100 MB, so they can’t be sent.',
    );
  });

  it('says both when the kinds are mixed', () => {
    expect(
      rejectedFilesMessage([
        { name: 'a', problem: 'too-large' },
        { name: 'b', problem: 'empty' },
      ]),
    ).toBe('“a” is over 100 MB, so it can’t be sent. “b” is empty.');
  });
});
