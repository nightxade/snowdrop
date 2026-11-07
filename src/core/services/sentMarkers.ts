import {
  isRecord,
  loadVersioned,
  saveVersioned,
  type KeyValueStorage,
  type VersionedSchema,
} from '@/core/persistence';

/** The record is `${SENT_MARKERS_KEY_PREFIX}:${scope}` (scoped per account in `app/dataScope.ts`). */
export const SENT_MARKERS_KEY_PREFIX = 'snowdrop.sentMarkers';

/** What is known about a message the backend acknowledged but whose commit could not be stored. */
export interface SentMarker {
  sentAt: number;
  expiresAt?: number;
}

type MarkerMap = Record<string, SentMarker>;

function parse(data: unknown): MarkerMap | null {
  if (!isRecord(data)) return null;
  const out: MarkerMap = {};
  for (const [nonce, value] of Object.entries(data)) {
    if (!isRecord(value) || typeof value.sentAt !== 'number') continue;
    out[nonce] = {
      sentAt: value.sentAt,
      ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
    };
  }
  return out;
}

/**
 * A second, small record of acknowledged-but-uncommitted sends (nonce to
 * `sentAt`), kept in the local key-value storage rather than the message
 * repository. The repository failing to record a send is the very situation
 * this covers, and it will usually fail to take a marker too. Consulted by
 * `SendService.restoreOutbox` so such a message is completed, never resent.
 */
export class SentMarkers {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly scope: () => string,
  ) {}

  private schema(): VersionedSchema<MarkerMap> {
    return {
      key: `${SENT_MARKERS_KEY_PREFIX}:${this.scope()}`,
      version: 1,
      defaults: () => ({}),
      parse,
    };
  }

  get(nonce: string): SentMarker | undefined {
    return loadVersioned(this.storage, this.schema())[nonce];
  }

  set(nonce: string, marker: SentMarker): void {
    const schema = this.schema();
    saveVersioned(this.storage, schema, {
      ...loadVersioned(this.storage, schema),
      [nonce]: marker,
    });
  }

  clear(nonce: string): void {
    const schema = this.schema();
    const all = loadVersioned(this.storage, schema);
    if (!(nonce in all)) return;
    const { [nonce]: _gone, ...rest } = all;
    if (Object.keys(rest).length === 0) this.storage.removeItem(schema.key);
    else saveVersioned(this.storage, schema, rest);
  }
}
