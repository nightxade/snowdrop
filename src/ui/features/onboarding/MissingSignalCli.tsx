import { useState } from 'react';
import { Button, TextInput } from '@/ui/primitives';
import styles from './Setup.module.css';

/**
 * Desktop app, `not-installed`: no signal-cli to run (a build without the
 * bundled copy, and none on PATH). Say how to get one, or take its path.
 */
export function MissingSignalCli({
  message,
  onSubmit,
}: {
  message: string | null;
  onSubmit: (path: string) => void;
}) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const error = value.trim().startsWith('/') ? null : 'Enter the full path, starting with /.';
  return (
    <section className={styles.card} aria-labelledby="missing-title">
      <h2 id="missing-title" className={styles.title}>
        signal-cli isn’t available
      </h2>
      <p className={styles.lede}>
        {message ?? 'Snowdrop couldn’t find signal-cli.'} Builds of Snowdrop from its release page
        include signal-cli; this one doesn’t. Install it (the <code>Linux-native</code> download
        needs no Java), then tell Snowdrop where it is.
      </p>
      <form
        className={styles.nameForm}
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!error) onSubmit(value.trim());
        }}
      >
        <TextInput
          label="Path to signal-cli"
          value={value}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="/usr/local/bin/signal-cli"
          error={touched ? (error ?? undefined) : undefined}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          onBlur={() => {
            setTouched(true);
          }}
        />
        <Button type="submit" variant="primary">
          Use it
        </Button>
      </form>
    </section>
  );
}
