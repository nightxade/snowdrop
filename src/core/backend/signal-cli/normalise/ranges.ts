/**
 * Body ranges ⇄ signal-cli's representation.
 *
 * Inbound: `textStyles` ({style,start,length}) and `mentions` ({uuid,number,
 * start,length}) become one sorted `BodyRange[]`. Offsets are UTF-16 code
 * units on both sides, so no conversion is needed — only validation, because
 * a range past the end of the body would crash the segment renderer.
 * Outbound: ranges become the CLI-style `start:length:X` strings that the
 * `send` method's `textStyle` / `mention` params expect.
 */
import type { BodyRange, TextStyle } from '@/core/domain';
import { addressId, type WireMention, type WireTextStyle } from '../wire';

const FROM_WIRE: Record<string, TextStyle> = {
  BOLD: 'bold',
  ITALIC: 'italic',
  STRIKETHROUGH: 'strikethrough',
  MONOSPACE: 'monospace',
  SPOILER: 'spoiler',
};

const TO_WIRE: Record<TextStyle, string> = {
  bold: 'BOLD',
  italic: 'ITALIC',
  strikethrough: 'STRIKETHROUGH',
  monospace: 'MONOSPACE',
  spoiler: 'SPOILER',
};

export function styleFromWire(style: string): TextStyle | undefined {
  return FROM_WIRE[style.toUpperCase()];
}

/** Clamps a range to the body; returns null when nothing of it is left. */
function clamp(start: number, length: number, bodyLength: number): [number, number] | null {
  if (!Number.isInteger(start) || !Number.isInteger(length)) return null;
  const s = Math.max(0, start);
  const e = Math.min(bodyLength, start + length);
  return e > s ? [s, e - s] : null;
}

export function sortRanges(ranges: BodyRange[]): BodyRange[] {
  return ranges.sort((a, b) => a.start - b.start || b.length - a.length);
}

export function toBodyRanges(
  body: string,
  textStyles: readonly WireTextStyle[],
  mentions: readonly WireMention[],
): BodyRange[] {
  const out: BodyRange[] = [];
  for (const t of textStyles) {
    const style = styleFromWire(t.style);
    const span = clamp(t.start, t.length, body.length);
    // Unknown styles (e.g. "NONE" or future ones) are dropped, text stays.
    if (style && span) out.push({ start: span[0], length: span[1], style });
  }
  for (const m of mentions) {
    const id = addressId(m.uuid, m.number, m.name);
    const span = clamp(m.start, m.length, body.length);
    if (id && span) out.push({ start: span[0], length: span[1], mentionId: id });
  }
  return sortRanges(out);
}

/** `send` param `textStyle`: `["0:4:BOLD", …]`. */
export function textStyleParams(ranges: readonly BodyRange[]): string[] {
  return ranges.flatMap((r) =>
    r.style && r.length > 0 ? [`${r.start}:${r.length}:${TO_WIRE[r.style]}`] : [],
  );
}

/** `send` param `mention`: `["5:1:<aci|number>", …]`. */
export function mentionParams(ranges: readonly BodyRange[]): string[] {
  return ranges.flatMap((r) =>
    r.mentionId !== undefined && r.length > 0 ? [`${r.start}:${r.length}:${r.mentionId}`] : [],
  );
}
