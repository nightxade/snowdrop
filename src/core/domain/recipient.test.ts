import { describe, expect, it } from 'vitest';
import { classifyRecipientInput, parsePhoneInput, parseUsernameInput } from './recipient';

const US = '+12025550100';

describe('parsePhoneInput', () => {
  it('normalises international numbers to E.164', () => {
    expect(parsePhoneInput('+1 (202) 555-0123')).toBe('+12025550123');
    expect(parsePhoneInput('+44 7911 123456')).toBe('+447911123456');
    expect(parsePhoneInput('  +49.30.1234567 ')).toBe('+49301234567');
  });

  it('reads a leading 00 as +', () => {
    expect(parsePhoneInput('0044 7911 123456')).toBe('+447911123456');
  });

  it('reads a national number in the user own region when that is NANP', () => {
    expect(parsePhoneInput('(202) 555-0123', US)).toBe('+12025550123');
    expect(parsePhoneInput('1 202 555 0123', US)).toBe('+12025550123');
    expect(parsePhoneInput('202-555-0123', '+447911123456')).toBeNull();
    expect(parsePhoneInput('202-555-0123')).toBeNull();
    // Area codes never start with 0 or 1.
    expect(parsePhoneInput('102 555 0123', US)).toBeNull();
  });

  it('rejects text that is not a plausible number', () => {
    expect(parsePhoneInput('alice')).toBeNull();
    expect(parsePhoneInput('+')).toBeNull();
    expect(parsePhoneInput('+123456')).toBeNull();
    expect(parsePhoneInput('+1234567890123456')).toBeNull();
    expect(parsePhoneInput('+0123456789')).toBeNull();
    expect(parsePhoneInput('+1 202 555 0123 ext 4')).toBeNull();
    expect(parsePhoneInput('')).toBeNull();
  });
});

describe('parseUsernameInput', () => {
  it('accepts name.123 with or without @', () => {
    expect(parseUsernameInput('alice.42')).toBe('alice.42');
    expect(parseUsernameInput('@alice.42')).toBe('alice.42');
    expect(parseUsernameInput('  _bob_9.123  ')).toBe('_bob_9.123');
  });

  it('rejects names without a discriminator and malformed ones', () => {
    expect(parseUsernameInput('alice')).toBeNull();
    expect(parseUsernameInput('alice.')).toBeNull();
    expect(parseUsernameInput('alice.4')).toBeNull();
    expect(parseUsernameInput('al.42')).toBeNull();
    expect(parseUsernameInput('9lives.42')).toBeNull();
    expect(parseUsernameInput('a'.repeat(33) + '.42')).toBeNull();
    expect(parseUsernameInput('alice-b.42')).toBeNull();
    expect(parseUsernameInput('202.555')).toBeNull();
  });

  it('applies Signal discriminator rules', () => {
    expect(parseUsernameInput('alice.00')).toBeNull();
    expect(parseUsernameInput('alice.007')).toBeNull();
    expect(parseUsernameInput('alice.01')).toBe('alice.01');
    expect(parseUsernameInput('alice.012')).toBeNull();
  });
});

describe('classifyRecipientInput', () => {
  it('tells numbers from usernames from plain names', () => {
    expect(classifyRecipientInput('+44 7911 123456')).toEqual({
      phone: '+447911123456',
      username: null,
      needsCountryCode: false,
    });
    expect(classifyRecipientInput('alice.42')).toEqual({
      phone: null,
      username: 'alice.42',
      needsCountryCode: false,
    });
    expect(classifyRecipientInput('alice')).toEqual({
      phone: null,
      username: null,
      needsCountryCode: false,
    });
  });

  it('flags a number that needs a country code', () => {
    expect(classifyRecipientInput('07911 123456').needsCountryCode).toBe(true);
    expect(classifyRecipientInput('07911 123456', US).needsCountryCode).toBe(true);
    expect(classifyRecipientInput('(202) 555-0123', US).needsCountryCode).toBe(false);
    expect(classifyRecipientInput('555').needsCountryCode).toBe(false);
    expect(classifyRecipientInput('+4479').needsCountryCode).toBe(false);
  });
});
