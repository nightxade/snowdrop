import { describe, expect, it } from 'vitest';
import {
  defaultDeviceName,
  initialLinkState,
  isExpiry,
  linkReducer,
  type LinkState,
} from './linkFlow';

const run = (state: LinkState, ...actions: Parameters<typeof linkReducer>[1][]) =>
  actions.reduce(linkReducer, state);

describe('link flow state machine', () => {
  it('goes naming → starting → waiting → linked', () => {
    let s = initialLinkState('Shrike (Firefox on Linux)');
    s = run(s, { type: 'start' });
    expect(s).toEqual({ step: 'starting', deviceName: 'Shrike (Firefox on Linux)', attempt: 1 });
    s = run(s, { type: 'started', uri: 'sgnl://linkdevice?uuid=x', attempt: 1 });
    expect(s).toMatchObject({ step: 'waiting', uri: 'sgnl://linkdevice?uuid=x' });
    s = run(s, { type: 'linked', accountId: 'aci-1', attempt: 1 });
    expect(s).toEqual({
      step: 'linked',
      deviceName: 'Shrike (Firefox on Linux)',
      accountId: 'aci-1',
    });
  });

  it('needs a name, trims it and caps its length', () => {
    expect(run(initialLinkState('  '), { type: 'start' }).step).toBe('naming');
    const s = run(initialLinkState('x'), { type: 'rename', deviceName: `  ${'a'.repeat(80)}` });
    expect(s.deviceName.length).toBe(50);
    expect(run(initialLinkState(' My laptop '), { type: 'start' }).deviceName).toBe('My laptop');
  });

  it('fails, then retries with a new attempt', () => {
    let s = run(
      initialLinkState('d'),
      { type: 'start' },
      { type: 'started', uri: 'u', attempt: 1 },
    );
    s = run(s, { type: 'failed', message: 'timed out', expired: true, attempt: 1 });
    expect(s).toMatchObject({ step: 'failed', expired: true, attempt: 1 });
    s = run(s, { type: 'rename', deviceName: 'phone-side name' }, { type: 'start' });
    expect(s).toMatchObject({ step: 'starting', attempt: 2, deviceName: 'phone-side name' });
  });

  it('ignores results from an abandoned attempt', () => {
    let s = run(initialLinkState('d'), { type: 'start' });
    // Back to the name field and start again: attempt 1's late answer must not count.
    s = run(s, { type: 'edit' }, { type: 'start' });
    expect(s).toMatchObject({ step: 'starting', attempt: 2 });
    expect(run(s, { type: 'started', uri: 'old', attempt: 1 })).toBe(s);
    const w = run(s, { type: 'started', uri: 'new', attempt: 2 });
    expect(w).toMatchObject({ step: 'waiting', uri: 'new' });
    expect(run(w, { type: 'linked', accountId: 'x', attempt: 7 })).toBe(w);
    expect(run(w, { type: 'failed', message: 'x', attempt: 7 })).toBe(w);
  });

  it('cannot restart while waiting or after linking', () => {
    const w = run(
      initialLinkState('d'),
      { type: 'start' },
      { type: 'started', uri: 'u', attempt: 1 },
    );
    expect(run(w, { type: 'start' })).toBe(w);
    expect(run(w, { type: 'rename', deviceName: 'z' })).toBe(w);
    const l = run(w, { type: 'linked', accountId: 'a', attempt: 1 });
    expect(run(l, { type: 'edit' })).toBe(l);
  });

  it('names the device after the browser and OS', () => {
    expect(
      defaultDeviceName('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'),
    ).toBe('Shrike (Firefox on Linux)');
    expect(
      defaultDeviceName(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 Version/17 Safari/605',
      ),
    ).toBe('Shrike (Safari on Mac)');
    expect(defaultDeviceName('')).toBe('Shrike');
  });

  it('recognises an expired code', () => {
    expect(isExpiry(Object.assign(new Error('x'), { kind: 'timeout' }))).toBe(true);
    expect(isExpiry(new Error('Link request timed out'))).toBe(true);
    expect(isExpiry(new Error('Bad request'))).toBe(false);
  });
});
