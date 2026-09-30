/**
 * Guards the dev/preview proxy to the signal-cli daemon.
 *
 * The daemon has no authentication; its only protection is that it listens
 * on loopback and rejects foreign Host headers. Our proxy rewrites Host
 * (`changeOrigin`), so without this guard *any* web page the user visits
 * could drive the daemon through the proxy (read messages, send as them):
 * Vite's default CORS policy allows other localhost origins, and a DNS
 * rebinding page could make itself look same-host. So every request must:
 * - arrive on a loopback Host (a `vite --host` LAN address is refused), and
 * - come from the app's own origin: `Sec-Fetch-Site` must be same-origin
 *   (or `none`, a URL typed by the user), and `Origin`, when sent, must equal
 *   the app's origin.
 * Non-browser clients (curl) send neither header; they can reach the daemon
 * directly anyway, so they gain nothing from the proxy.
 */

export type HeaderValue = string | string[] | undefined;

export interface GuardRequest {
  headers: Record<string, HeaderValue>;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

const first = (value: HeaderValue): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Hostname part of a Host header (`[::1]:5173` → `[::1]`, `localhost:5173` → `localhost`). */
export function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  const name = hostnameOf(host);
  return name === 'localhost' || name === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(name);
}

export function checkSignalCliRequest(req: GuardRequest): GuardResult {
  const host = first(req.headers.host);
  if (!host || !isLoopbackHost(host)) {
    return { ok: false, reason: 'signal-cli proxy only serves loopback hosts' };
  }
  const site = first(req.headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { ok: false, reason: `cross-site request (${site})` };
  }
  const origin = first(req.headers.origin);
  if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return { ok: false, reason: `foreign origin ${origin}` };
  }
  return { ok: true };
}
