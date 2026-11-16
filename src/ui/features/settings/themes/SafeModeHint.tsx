import { useSnowdrop } from '@/ui/hooks';

/** How to start without imported themes and Custom CSS, for this build. */
export function SafeModeHint({ cause, without }: { cause: string; without: string }) {
  const { desktop } = useSnowdrop();
  return desktop !== null ? (
    <>
      If {cause} ever makes Snowdrop unusable, start it with <code>snowdrop --safe</code> to open it
      without {without}.
    </>
  ) : (
    <>
      If {cause} ever makes Snowdrop unusable, add <code>?safe=1</code> to the address to open it
      without {without}.
    </>
  );
}
