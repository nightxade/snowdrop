/** The subset of the Web Storage API we need; lets tests use an in-memory map. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /**
   * Every key currently stored. Optional: only `hydrateKeyValue` (crypto/)
   * needs it, to decrypt everything once after unlock, and not every
   * storage worth wrapping (e.g. a narrow test double) can offer it cheaply.
   */
  keys?(): string[];
}
