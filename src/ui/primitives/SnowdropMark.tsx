import { useId } from 'react';

/** Outer tepals, hanging from the top of the flower at (0, 0). */
const CENTRE = 'M0 1C7 6 9 21 5.5 29.5 4 33 1.5 34.5 0 36-1.5 34.5-4 33-5.5 29.5-9 21-7 6 0 1Z';
const SIDE = 'M1 0C12 0 20 12 21 25 21.4 29.5 18.5 31.5 15.5 30 10 26.5 5 16 1 3Z';
/** The ovary: a small round cap where the stem meets the flower. */
const CAP = { cx: 0, cy: -0.5, r: 4.25 } as const;

/**
 * Snowdrop's glyph: a single nodding snowdrop, three outer tepals (the side
 * ones flared) hanging from a short arched stem, with the ovary cap on top.
 * One colour (currentColor): thin gaps knocked out between the tepals and
 * around the cap keep the parts legible. public/snowdrop.svg is the same
 * drawing in colour (white flower, green stem and cap) on a tile.
 */
export function SnowdropMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string | undefined;
}) {
  // Mask ids must be unique per instance (several marks can be on screen).
  const id = useId().replace(/[^\w-]/gu, '');
  const side = `${id}-side`;
  const mid = `${id}-mid`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="8 5 50 50"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <defs>
        <mask id={side}>
          <rect x="-32" y="-32" width="64" height="72" fill="#fff" />
          {/* Explicit fills: mask content would otherwise inherit currentColor. */}
          <path d={CENTRE} fill="#000" stroke="#000" strokeWidth="2.5" />
          <circle {...CAP} fill="#000" stroke="#000" strokeWidth="2.5" />
        </mask>
        <mask id={mid}>
          <rect x="-32" y="-32" width="64" height="72" fill="#fff" />
          <circle {...CAP} fill="#000" stroke="#000" strokeWidth="2.5" />
        </mask>
      </defs>
      <path
        d="M21 14C25 7 32 7 33 15"
        fill="none"
        stroke="currentColor"
        strokeWidth="4.25"
        strokeLinecap="round"
      />
      <g transform="translate(33 19)">
        <g mask={`url(#${side})`}>
          <path d={SIDE} />
          <path d={SIDE} transform="scale(-1 1)" />
        </g>
        <path d={CENTRE} mask={`url(#${mid})`} />
        <circle {...CAP} />
      </g>
    </svg>
  );
}
