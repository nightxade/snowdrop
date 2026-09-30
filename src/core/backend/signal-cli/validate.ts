/**
 * A tiny decoder toolkit for validating daemon JSON at the boundary.
 *
 * Why hand-rolled instead of valibot/zod: we need ~10 combinators, and one
 * behaviour those libraries don't give us for free — *lenient* optional
 * sub-objects. signal-cli grows new envelope fields every release and
 * serialises absent values as `null`; a malformed `quote` must not drop the
 * whole message, so `maybe()` records an issue and yields `undefined`
 * instead of failing the parent. Output types are inferred from the decoders,
 * so wire types are declared exactly once.
 */

export class DecodeError extends Error {
  override name = 'DecodeError';
  constructor(
    readonly path: string,
    readonly expected: string,
  ) {
    super(`${path || '<root>'}: expected ${expected}`);
  }
}

/** Collects non-fatal problems (lenient fields that were dropped). */
export type Issues = string[];

export type Decoder<T> = (value: unknown, path: string, issues: Issues) => T;

export type Infer<D> = D extends Decoder<infer T> ? T : never;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const str: Decoder<string> = (v, path) => {
  if (typeof v !== 'string') throw new DecodeError(path, 'string');
  return v;
};

export const num: Decoder<number> = (v, path) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DecodeError(path, 'number');
  return v;
};

export const bool: Decoder<boolean> = (v, path) => {
  if (typeof v !== 'boolean') throw new DecodeError(path, 'boolean');
  return v;
};

export const unknownValue: Decoder<unknown> = (v) => v;

/** `null`/`undefined` → `undefined`; anything else must decode (errors propagate). */
export function opt<T>(d: Decoder<T>): Decoder<T | undefined> {
  return (v, path, issues) => (v === null || v === undefined ? undefined : d(v, path, issues));
}

/**
 * Like `opt`, but an invalid value is recorded as an issue and treated as
 * absent, so one bad field never takes its parent down with it.
 */
export function maybe<T>(d: Decoder<T>): Decoder<T | undefined> {
  return (v, path, issues) => {
    if (v === null || v === undefined) return undefined;
    try {
      return d(v, path, issues);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `${path}: invalid`);
      return undefined;
    }
  };
}

/** Falls back to `fallback` when absent or invalid (lenient). */
export function withDefault<T>(d: Decoder<T>, fallback: T): Decoder<T> {
  const inner = maybe(d);
  return (v, path, issues) => inner(v, path, issues) ?? fallback;
}

/** Strict array: every item must decode. */
export function array<T>(d: Decoder<T>): Decoder<T[]> {
  return (v, path, issues) => {
    if (!Array.isArray(v)) throw new DecodeError(path, 'array');
    return v.map((item, i) => d(item, `${path}[${i}]`, issues));
  };
}

/** Lenient array: invalid items are dropped (and recorded); non-arrays → []. */
export function list<T>(d: Decoder<T>): Decoder<T[]> {
  return (v, path, issues) => {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) {
      issues.push(`${path}: expected array`);
      return [];
    }
    const out: T[] = [];
    v.forEach((item, i) => {
      try {
        out.push(d(item, `${path}[${i}]`, issues));
      } catch (error) {
        issues.push(error instanceof Error ? error.message : `${path}[${i}]: invalid`);
      }
    });
    return out;
  };
}

export function oneOf<const T extends string>(options: readonly T[]): Decoder<T> {
  return (v, path) => {
    if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T;
    throw new DecodeError(path, options.map((o) => JSON.stringify(o)).join(' | '));
  };
}

type Shape = Record<string, Decoder<unknown>>;
type FromShape<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

/** Decodes the listed keys; unknown keys are ignored (forward compatibility). */
export function object<S extends Shape>(shape: S): Decoder<FromShape<S>> {
  return (v, path, issues) => {
    if (!isRecord(v)) throw new DecodeError(path, 'object');
    const out: Record<string, unknown> = {};
    for (const [key, d] of Object.entries(shape)) {
      out[key] = d(v[key], path ? `${path}.${key}` : key, issues);
    }
    return out as FromShape<S>;
  };
}

export type DecodeResult<T> =
  { ok: true; value: T; issues: Issues } | { ok: false; error: DecodeError; issues: Issues };

export function decode<T>(d: Decoder<T>, value: unknown): DecodeResult<T> {
  const issues: Issues = [];
  try {
    return { ok: true, value: d(value, '', issues), issues };
  } catch (error) {
    const e = error instanceof DecodeError ? error : new DecodeError('', String(error));
    return { ok: false, error: e, issues };
  }
}

/** Decodes or throws the DecodeError (for RPC results, where failure is an error). */
export function decodeOrThrow<T>(d: Decoder<T>, value: unknown): T {
  const result = decode(d, value);
  if (!result.ok) throw result.error;
  return result.value;
}
