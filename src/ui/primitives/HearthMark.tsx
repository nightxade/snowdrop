/** Hearth's glyph (a flame over a hearthstone), in currentColor. Same drawing as public/hearth.svg. */
export function HearthMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string | undefined;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="6 3 20 26"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M16 5c1.5 4.5 7 7.2 7 13.2A7 7 0 0 1 9 18.2c0-3 1.6-5 3.4-6.6.2 2.3 1.2 3.7 2.6 4.3C14.6 11.8 15 8.4 16 5z" />
      <rect x="8" y="25" width="16" height="2.4" rx="1.2" opacity=".55" />
    </svg>
  );
}
