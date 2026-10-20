import { array, bool, DecodeError, isRecord, object, opt, str, type Decoder } from '../validate';

export type BackupRecord = Record<string, unknown>;
export const record = (value: unknown): BackupRecord => (isRecord(value) ? value : {});
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const records = (value: unknown): BackupRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** Protobuf uint64s are strings, including values beyond JavaScript's safe integer range. */
export function decimal(value: unknown): string {
  if (value === undefined) return '0'; // proto3 omits fields with their default value
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error('Invalid archive integer');
  return value;
}

/** Timestamps must be representable before crossing into the domain model. */
export function timestamp(value: unknown): number {
  const number = Number(decimal(value));
  if (!Number.isSafeInteger(number)) throw new Error('Archive timestamp is out of range');
  return number;
}

/** A proto3 `uint32`: absent means the field was omitted at its default (0), not "unknown". */
export function uint32(value: unknown, fallback?: 0): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
    ? value
    : undefined;
}

/**
 * A proto3 `bytes` field (base64 on the wire), hex-encoded — what
 * signal-cli's RPCs expect for sticker pack/attachment ids elsewhere. Only
 * ever used for plain identifiers here, never key material (see
 * StickerContent's own doc comment on why a pack's decryption key never
 * takes this path).
 */
export function hexBytes(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const bytes = atob(value);
    return Array.from(bytes, (b) => b.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

const frame: Decoder<BackupRecord> = (value, path) => {
  if (!isRecord(value)) throw new DecodeError(path, 'backup frame');
  return value;
};
const cursor: Decoder<string> = (value, path) => {
  try {
    if (typeof value !== 'string') throw new Error('Missing cursor');
    return decimal(value);
  } catch {
    throw new DecodeError(path, 'decimal cursor');
  }
};
export const historyPage = object({
  archiveId: opt(str),
  entries: array(object({ cursor, frame })),
  nextCursor: opt(cursor),
  hasMore: bool,
});

export const historyReadStates = array(
  object({
    cursor,
    expiresAt: opt(cursor),
    unavailable: bool,
  }),
);
