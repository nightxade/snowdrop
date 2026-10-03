/**
 * Colour math for accent derivation.
 *
 * Hover/active shades are computed in OKLCH so lightening an accent keeps its
 * perceived hue and saturation (sRGB/HSL mixing shifts hue and muddies
 * saturated oranges). Out-of-gamut results are brought back by reducing
 * chroma, not by clipping channels, to preserve hue.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(hex.trim());
  if (!m) return null;
  let digits = m[1] as string;
  if (digits.length === 3) digits = digits.replace(/./gu, '$&$&');
  const n = parseInt(digits, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/** Unclamped conversion; channels may fall outside [0, 1]. */
function oklchToRgbRaw({ l: L, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const inGamut = ({ r, g, b }: Rgb, eps = 1e-4) => [r, g, b].every((v) => v >= -eps && v <= 1 + eps);

export function oklchToRgb(color: Oklch): Rgb {
  const l = Math.min(1, Math.max(0, color.l));
  let rgb = oklchToRgbRaw({ ...color, l });
  if (inGamut(rgb)) return rgb;
  let lo = 0;
  let hi = color.c;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToRgbRaw({ l, c: mid, h: color.h }))) lo = mid;
    else hi = mid;
  }
  rgb = oklchToRgbRaw({ l, c: lo, h: color.h });
  return rgb;
}

/** Shifts perceptual lightness by `delta` (−1..1), preserving hue. */
export function adjustLightness(hex: string, delta: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const lch = rgbToOklch(rgb);
  return toHex(oklchToRgb({ ...lch, l: lch.l + delta }));
}

export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const c = (v: number) => Math.round(v * 255);
  return `rgba(${c(rgb.r)}, ${c(rgb.g)}, ${c(rgb.b)}, ${alpha})`;
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

export function contrastRatio(a: string, b: string): number {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return 1;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Parses `#rgb`, `#rrggbb`, `rgb()` and `rgba()` (comma or space syntax) into channels + alpha. */
export function parseColor(css: string): { rgb: Rgb; alpha: number } | null {
  const hex = parseHex(css);
  if (hex) return { rgb: hex, alpha: 1 };
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/iu.exec(
    css.trim(),
  );
  if (!m) return null;
  const ch = (v: string | undefined) => Math.min(255, Number(v)) / 255;
  const a = m[4];
  const alpha = a === undefined ? 1 : a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a);
  return { rgb: { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]) }, alpha: Math.min(1, Math.max(0, alpha)) };
}

/**
 * The opaque colour you see when `top` (possibly translucent, like the hover
 * tint) is painted over the opaque `base`. Null when either can't be parsed.
 */
export function compositeOver(top: string, base: string): string | null {
  const t = parseColor(top);
  const b = parseHex(base);
  if (!t || !b) return null;
  const mix = (f: number, g: number) => f * t.alpha + g * (1 - t.alpha);
  return toHex({ r: mix(t.rgb.r, b.r), g: mix(t.rgb.g, b.g), b: mix(t.rgb.b, b.b) });
}
