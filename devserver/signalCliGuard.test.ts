// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkSignalCliRequest, hostnameOf, isLoopbackHost } from './signalCliGuard';

const req = (headers: Record<string, string>) => ({ headers });

describe('signal-cli proxy guard', () => {
  it('allows same-origin requests from the app', () => {
    expect(
      checkSignalCliRequest(
        req({
          host: 'localhost:5173',
          'sec-fetch-site': 'same-origin',
          origin: 'http://localhost:5173',
        }),
      ),
    ).toEqual({ ok: true });
    // GET fetches don't send Origin; curl sends no fetch metadata at all.
    expect(
      checkSignalCliRequest(req({ host: '127.0.0.1:5173', 'sec-fetch-site': 'same-origin' })).ok,
    ).toBe(true);
    expect(checkSignalCliRequest(req({ host: '[::1]:5173' })).ok).toBe(true);
    expect(
      checkSignalCliRequest(req({ host: 'localhost:5173', 'sec-fetch-site': 'none' })).ok,
    ).toBe(true);
  });

  it.each([
    [
      'another localhost app',
      { host: 'localhost:5173', 'sec-fetch-site': 'same-site', origin: 'http://localhost:3000' },
    ],
    [
      'a website',
      { host: 'localhost:5173', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    ],
    [
      'a foreign Origin without fetch metadata',
      { host: 'localhost:5173', origin: 'http://localhost:3000' },
    ],
    [
      'DNS rebinding (non-loopback Host)',
      {
        host: 'evil.example:5173',
        'sec-fetch-site': 'same-origin',
        origin: 'http://evil.example:5173',
      },
    ],
    ['a LAN address (vite --host)', { host: '192.168.1.20:5173', 'sec-fetch-site': 'same-origin' }],
    ['a missing Host', {}],
  ])('rejects %s', (_label, headers) => {
    expect(checkSignalCliRequest(req(headers)).ok).toBe(false);
  });

  it('parses hosts', () => {
    expect(hostnameOf('[::1]:5173')).toBe('[::1]');
    expect(hostnameOf('LocalHost:80')).toBe('localhost');
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackHost('sub.localhost')).toBe(false);
  });
});
