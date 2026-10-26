/**
 * The localStorage key names the signal-cli adapter keeps per account. In one
 * place so signing out (`app/dataScope.ts`, `accountDataKeys`) can find
 * exactly what the adapter wrote without duplicating the formats. On the
 * desktop these names never reach the disk: the encrypted store blinds every
 * key name (docs/ENCRYPTION.md, "Web cache").
 */

/** Every resume cursor key starts with this; the account id is the last dot-separated part. */
export const CURSOR_KEY_PREFIX = 'snowdrop.signal-cli.cursor.';

/** The direct-conversation peers list for one account (`DirectPeers`). */
export const peersStorageKey = (accountId: string): string =>
  `snowdrop.signal-cli.peers.${accountId}`;

/** The groups this device left, for one account: signal-cli keeps them but lists them as not joined. */
export const leftGroupsStorageKey = (accountId: string): string =>
  `snowdrop.signal-cli.left-groups.${accountId}`;

/** Resume cursors are per transport kind (an SSE id means nothing to the desktop). */
export const cursorStorageKey = (resumeScope: string, accountId: string): string =>
  `${CURSOR_KEY_PREFIX}${resumeScope}.${accountId}`;
