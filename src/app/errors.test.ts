/**
 * `toAppError` from every error family the app produces, and the helpers that
 * say why a failure is dropped.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { DesktopErrorKind } from '@/core/backend';
import { MockBackend, MockBackendError } from '@/core/backend/mock';
import { SignalCliError, type SignalCliErrorKind } from '@/core/backend/signal-cli';
import {
  AppError,
  ignore,
  ignored,
  toAppError,
  UnsupportedError,
  type ErrorKind,
} from '@/core/lib';
import { asCommandError, IpcValidationError } from '@/platform/tauri/ipc';
import {
  describeFailure,
  describeSendFailure,
  friendlyAppError,
  friendlyErrorMessage,
} from '@/ui/lib/connectionErrors';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error kinds', () => {
  it('every family’s kinds are kinds of the one contract', () => {
    expectTypeOf<SignalCliErrorKind>().toExtend<ErrorKind>();
    expectTypeOf<DesktopErrorKind>().toExtend<ErrorKind>();
  });
});

describe('toAppError', () => {
  it('returns an AppError as it is', () => {
    const error = new AppError('timeout', 'slow');
    expect(toAppError(error)).toBe(error);
  });

  it('a plain AppError timeout may have sent, matching wire objects', () => {
    expect(new AppError('timeout', 'slow').outcome).toBe('maybe-sent');
    expect(toAppError({ kind: 'timeout', message: 'slow' }).outcome).toBe('maybe-sent');
    expect(new AppError('internal', 'bug').outcome).toBe('unknown');
  });

  it('SignalCliError is an AppError with its transient and outcome rules', () => {
    const timeout = new SignalCliError('timeout', 'slow');
    expect(toAppError(timeout)).toBe(timeout);
    expect(timeout).toBeInstanceOf(AppError);
    expect(timeout).toMatchObject({ kind: 'timeout', transient: true, outcome: 'maybe-sent' });
    expect(new SignalCliError('unreachable', 'down')).toMatchObject({
      transient: true,
      outcome: 'unknown',
    });
    expect(new SignalCliError('rate-limited', 'slow down')).toMatchObject({
      transient: false,
      outcome: 'not-sent',
    });
    expect(new SignalCliError('invalid-response', 'bad', { requestSent: true }).outcome).toBe(
      'maybe-sent',
    );
  });

  it('a wire { kind, message } from the desktop shell keeps its kind and message', () => {
    const converted = toAppError({ kind: 'keyring-locked', message: 'locked' });
    expect(converted).toBeInstanceOf(AppError);
    expect(converted).toMatchObject({
      kind: 'keyring-locked',
      message: 'locked',
      outcome: 'unknown',
    });
    expect(asCommandError({ kind: 'keyring-locked', message: 'locked' })).toEqual({
      kind: 'keyring-locked',
      message: 'locked',
    });
  });

  it('a wire timeout may have been carried out', () => {
    expect(toAppError({ kind: 'timeout', message: '' }).outcome).toBe('maybe-sent');
    expect(toAppError({ kind: 'user', message: '', requestSent: true }).outcome).toBe('maybe-sent');
  });

  it('IpcValidationError is the one invalid-response error', () => {
    const error = new IpcValidationError('x: bad');
    expect(error).toBeInstanceOf(AppError);
    expect(toAppError(error)).toMatchObject({ kind: 'invalid-response', message: 'x: bad' });
    expect(asCommandError(error)).toEqual({ kind: 'invalid-response', message: 'x: bad' });
  });

  it('MockBackendError carries a kind and never sent anything', () => {
    expect(toAppError(new MockBackendError('Not connected'))).toMatchObject({
      kind: 'unknown',
      outcome: 'not-sent',
    });
    expect(new MockBackendError('no', 'user').kind).toBe('user');
  });

  it('UnsupportedError is an AppError of kind unsupported, kept by toAppError and never sent', async () => {
    const error = new UnsupportedError('resolveAvatarUrl');
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: 'unsupported', outcome: 'not-sent' });
    expect(toAppError(error)).toBe(error);
    // What an adapter without the method rejects with.
    const rejected: unknown = await new MockBackend().resolveAvatarUrl().then(
      () => null,
      (e: unknown) => e,
    );
    expect(rejected).toBeInstanceOf(UnsupportedError);
    expect(toAppError(rejected)).toMatchObject({ kind: 'unsupported' });
    expect(friendlyErrorMessage('unsupported')).not.toBe(friendlyErrorMessage('nonsense'));
  });

  it('a plain Error, a string and nothing become unknown, keeping the cause', () => {
    const plain = new Error('boom');
    expect(toAppError(plain)).toMatchObject({ kind: 'unknown', message: 'boom', cause: plain });
    expect(toAppError('text')).toMatchObject({ kind: 'unknown', message: 'text' });
    expect(toAppError(null)).toMatchObject({ kind: 'unknown' });
    expect(toAppError(undefined)).toMatchObject({ kind: 'unknown' });
    expect(asCommandError(plain)).toEqual({ kind: 'internal', message: 'boom' });
  });
});

describe('copy for a failure', () => {
  it('maps a kind to the shared copy and keeps the raw detail out of it', () => {
    const error = new AppError('rate-limited', 'raw detail 123');
    expect(friendlyAppError(error)).toBe(
      'Signal is rate-limiting this account. Try again shortly.',
    );
    expect(describeFailure(error)).not.toMatch(/raw detail/u);
  });

  it('keeps the message of a failure whose kind has no copy of its own', () => {
    expect(describeFailure(new Error('That file is too big.'))).toBe('That file is too big.');
    expect(describeFailure(new AppError('internal', 'disk write failed'))).toBe(
      'disk write failed',
    );
    expect(describeFailure(new Error(''), 'Try again.')).toBe('Try again.');
  });

  it('uses signal-cli wording only for errors that came from signal-cli', () => {
    const ipc = new IpcValidationError('storage_status: expected an object');
    expect(describeFailure(ipc)).toBe('storage_status: expected an object');
    expect(describeFailure(ipc)).not.toMatch(/signal-cli/iu);
    for (const kind of ['protocol', 'method-not-found', 'account-unavailable'] as const) {
      expect(describeFailure(new AppError(kind, 'raw'))).toBe('raw');
    }
    expect(describeFailure(new SignalCliError('invalid-response', 'raw'))).toMatch(/signal-cli/u);
    expect(describeFailure(new SignalCliError('method-not-found', 'raw'))).toMatch(/signal-cli/u);
  });

  it('a send that may have gone through never reads as a plain try-again', () => {
    const text = describeSendFailure(new SignalCliError('timeout', 'x'));
    expect(text).toMatch(/may have been sent/u);
    expect(text).not.toMatch(/try again/iu);
    expect(describeSendFailure(new SignalCliError('unreachable', 'x'))).toMatch(
      /Couldn.t connect/u,
    );
  });
});

describe('ignore', () => {
  it('logs the reason and the error’s class at debug, never its message', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    ignore(new SignalCliError('io', 'contains +15551234567'), 'best-effort cleanup');
    ignored('another reason')(new Error('also private'));
    const lines = debug.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toContain('ignored: best-effort cleanup');
    expect(lines[0]).toContain('SignalCliError(io)');
    expect(lines.join('\n')).not.toMatch(/555|private/u);
    expect(lines[1]).toContain('another reason');
  });
});
