/**
 * `link_preview_fetch` (src-tauri/src/link_preview.rs): fetches a URL's
 * Open Graph/Twitter-card/`<title>` metadata and, if present, its image —
 * entirely from this device (Settings → Behaviour → "Link previews"
 * explains what that means for privacy). The browser build has no Rust
 * side to call, so it never offers this at all (see `AppServices.linkPreviewFetch`).
 */
import type { OutgoingLinkPreview } from '@/core/backend';
import { decode, num, object, str, type Decoder } from '@/core/backend/signal-cli';
import { tauriIpc, type CommandError, type TauriIpc } from './ipc';

/** `null`/`undefined` → `undefined` (Rust's `Option<T>` serialises as JSON `null`). */
function optional<T>(d: Decoder<T>): Decoder<T | undefined> {
  return (v, path, issues) => (v === null || v === undefined ? undefined : d(v, path, issues));
}

class IpcValidationError extends Error implements CommandError {
  override readonly name = 'IpcValidationError';
  readonly kind: CommandError['kind'] = 'invalid-response';
}

const fetchedImageShape = object({
  contentType: str,
  base64: str,
  width: optional(num),
  height: optional(num),
});

const fetchedPreviewShape = object({
  url: str,
  title: str,
  description: optional(str),
  image: optional(fetchedImageShape),
});

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Resolves to `undefined` for "nothing to show" (a blocked scraper, a
 * timeout, a page with no usable tags — see the Rust side's own silent
 * `Ok(None)` for all of these) — never an error for those ordinary cases.
 * Rejects only for a genuine transport failure (Tauri IPC itself, or an
 * unrecognisable reply), which the caller treats the same way regardless.
 */
export async function linkPreviewFetch(
  url: string,
  ipc: TauriIpc = tauriIpc,
): Promise<OutgoingLinkPreview | undefined> {
  const raw = await ipc.invoke<unknown>('link_preview_fetch', { url });
  if (raw === null || raw === undefined) return undefined;
  const decoded = decode(fetchedPreviewShape, raw);
  if (!decoded.ok) {
    throw new IpcValidationError(`link_preview_fetch: ${decoded.error.message}`);
  }
  const preview = decoded.value;
  const result: OutgoingLinkPreview = { url: preview.url, title: preview.title };
  if (preview.description) result.description = preview.description;
  if (preview.image) {
    const bytes = base64ToBytes(preview.image.base64);
    const data = new Blob([bytes], {
      type: preview.image.contentType || 'application/octet-stream',
    });
    result.image = {
      contentType: preview.image.contentType,
      data,
      previewUrl: URL.createObjectURL(data),
      ...(preview.image.width ? { width: preview.image.width } : {}),
      ...(preview.image.height ? { height: preview.image.height } : {}),
    };
  }
  return result;
}
