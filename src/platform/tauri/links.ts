/**
 * Links never navigate the app window: web and mail links open in the
 * system browser through the `open_external` command (which re-checks the
 * scheme on the Rust side).
 */
import { tauriIpc, type TauriIpc } from './ipc';

const EXTERNAL = /^(https?:|mailto:)/iu;

export function installExternalLinks(
  doc: Document = document,
  ipc: TauriIpc = tauriIpc,
): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    const href = target.href;
    // In-app links (same origin: `tauri://localhost`, or the dev server) stay in the app.
    if (!EXTERNAL.test(href) || new URL(href, doc.baseURI).origin === doc.location.origin) return;
    event.preventDefault();
    void ipc.invoke('open_external', { url: href }).catch((error: unknown) => {
      console.warn('[snowdrop] could not open link', error);
    });
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('auxclick', onClick, true);
  };
}
