/**
 * Who "we" are on the daemon, and every identifier that means us.
 *
 * Multi-account daemons tell us both our ACI and number (`listAccounts`).
 * Single-account daemons (`signal-cli -a +X daemon`) have no such method, so
 * we start from what the user configured and *learn* the other half as it
 * shows up: the `account` field of every receive payload, and envelopes or
 * contact records whose number/uuid pair contains a known alias. All aliases
 * resolve to one canonical `selfId`, so our own messages, reaction targets and
 * mentions line up however the daemon happens to address us.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export class SelfIdentity {
  readonly aliases = new Set<string>();
  number: string | undefined;

  constructor(
    /** Canonical id: the ACI when known up front, else what the user configured. */
    readonly selfId: string,
    others: (string | undefined)[] = [],
  ) {
    for (const id of [selfId, ...others]) this.add(id);
  }

  /** Maps any alias of ours to `selfId`; other ids pass through. */
  resolve(id: string): string {
    return this.aliases.has(id) ? this.selfId : id;
  }

  isSelf(id: string): boolean {
    return this.aliases.has(id);
  }

  /** A number/uuid pair seen together: if either half is us, both are. */
  learnPair(uuid: string | undefined, number: string | undefined): void {
    if ((uuid && this.aliases.has(uuid)) || (number && this.aliases.has(number))) {
      this.add(uuid);
      this.add(number);
    }
  }

  add(id: string | undefined): void {
    if (!id) return;
    this.aliases.add(id);
    if (!isUuid(id)) this.number ??= id;
  }
}
