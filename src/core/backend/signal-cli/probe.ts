/**
 * Settings → Connection → "Test connection": checks a daemon URL without
 * touching the running backend, and reports whether it has an account.
 */
import { SignalCliError } from './errors';
import { JsonRpcClient, type FetchLike } from './rpc';
import { wireAccounts } from './wire';

export type ProbeResult =
  { ok: true; accounts: number | null } | { ok: false; kind: string; message: string };

export async function probeDaemon(
  baseUrl: string,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const rpc = new JsonRpcClient({
    baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeoutMs: options.timeoutMs ?? 5_000,
  });
  try {
    await rpc.check();
  } catch (error) {
    return failure(error);
  }
  try {
    const accounts = await rpc.call('listAccounts', undefined, wireAccounts, { account: null });
    return { ok: true, accounts: accounts.length };
  } catch (error) {
    // Single-account daemons don't list accounts; the daemon itself is fine.
    if (error instanceof SignalCliError && error.kind === 'method-not-found')
      return { ok: true, accounts: null };
    return failure(error);
  }
}

function failure(error: unknown): ProbeResult {
  if (error instanceof SignalCliError)
    return { ok: false, kind: error.kind, message: error.message };
  return {
    ok: false,
    kind: 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}
