/**
 * Bidi control characters (LRE/RLE/LRO/RLO/PDF, LRI/RLI/FSI/PDI, LRM/RLM, ALM) let a
 * string reorder or visually hide text around it. Attacker-controlled strings
 * (contact names, group titles, filenames, quoted authors) can carry them, so
 * anything built from such strings should run through this first — notably
 * before being used outside a CSS-isolated element (e.g. an `<a download>`
 * name, or interpolated into a plain-text sentence).
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;

export function stripBidiControls(s: string): string {
  return s.replace(BIDI_CONTROLS, '');
}
