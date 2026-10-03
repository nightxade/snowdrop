import { useState } from 'react';
import { Button, TextInput } from '@/ui/primitives';
import styles from './Setup.module.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** E.164 number (+ and 7–15 digits, spaces allowed) or an ACI. */
export function validateAccount(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Enter the phone number the daemon was started with.';
  if (UUID.test(v)) return null;
  const digits = v.replace(/[\s()-]/gu, '');
  return /^\+\d{7,15}$/u.test(digits)
    ? null
    : 'Use international format with a +, e.g. +44 7700 900123.';
}

export function normaliseAccount(value: string): string {
  const v = value.trim();
  return UUID.test(v) ? v.toLowerCase() : v.replace(/[\s()-]/gu, '');
}

/** Single-account daemons can't say whose they are: ask (PLAN §4.10, `account-required`). */
export function AccountPrompt({ onSubmit }: { onSubmit: (account: string) => void }) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const error = validateAccount(value);
  return (
    <section className={styles.card} aria-labelledby="account-title">
      <h2 id="account-title" className={styles.title}>
        Which account is this?
      </h2>
      <p className={styles.lede}>
        This signal-cli daemon was started for a single account (with <code>-a</code>) and can’t
        tell Snowdrop which one. Enter the same phone number.
      </p>
      <form
        className={styles.nameForm}
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!error) onSubmit(normaliseAccount(value));
        }}
      >
        <TextInput
          label="Phone number"
          value={value}
          inputMode="tel"
          autoComplete="tel"
          autoFocus
          placeholder="+44 7700 900123"
          error={touched ? (error ?? undefined) : undefined}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          onBlur={() => {
            setTouched(true);
          }}
        />
        <Button type="submit" variant="primary">
          Connect
        </Button>
      </form>
    </section>
  );
}
