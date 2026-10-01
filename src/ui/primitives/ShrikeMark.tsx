/**
 * Shrike's glyph: a shrike's head in profile, cut from straight lines, with a
 * hooked beak and the bird's black mask (knocked out, with the eye inside).
 * Drawn in currentColor; public/shrike.svg is the same drawing on a tile.
 */
export function ShrikeMark({
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
      viewBox="3.5 3.5 25.5 25.5"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path
        fillRule="evenodd"
        d="M3.5 16 6 8.5 12 4.5h6l4 4.5 5.5 2 1.5 2.2-1.5 5.8-1.8-3.6-4.2.8L19 24l-5.5 4h-4L4.5 23zM5.4 12.7 22 9.6v7l-16.6-.6zM15.2 11.2h2.6v2.6h-2.6z"
      />
    </svg>
  );
}
