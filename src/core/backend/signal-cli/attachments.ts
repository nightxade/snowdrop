/**
 * Attachment bytes ⇄ the daemon.
 *
 * signal-cli downloads attachments to its data dir and exposes them only via
 * the `getAttachment` RPC (base64 in JSON), so there is no URL we could put
 * straight into `<img src>`. We therefore resolve lazily — only when the UI
 * actually shows an attachment — into a `blob:` URL, deduplicate concurrent
 * requests, and keep a small LRU so scrolling back and forth doesn't
 * re-download or leak object URLs.
 */
import type { Attachment } from '@/core/domain';
import type { OutgoingAttachment } from '../types';
import { SignalCliError } from './errors';
import { toDataUri } from './params';
import type { JsonRpcClient, RpcParams } from './rpc';
import { wireAttachmentData } from './wire';

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...hugeArray) overflows the call stack.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Files up to this size keep a `data:` URL so our own sent images survive reloads. */
export const INLINE_PREVIEW_MAX_BYTES = 1_500_000;

export interface EncodedAttachment {
  /** What signal-cli's `attachment` param gets. */
  param: string;
  /** Our local record of the sent file (no daemon id: nothing echoes it back). */
  attachment: Attachment;
}

export async function encodeOutgoing(
  file: OutgoingAttachment,
  id: string,
): Promise<EncodedAttachment> {
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  const param = toDataUri(file.contentType, file.fileName, base64);
  const attachment: Attachment = {
    id,
    contentType: file.contentType || 'application/octet-stream',
    fileName: file.fileName,
    size: bytes.length,
  };
  // Plain data URL (no filename param) so browsers render it; the repository
  // persists it, unlike a blob: URL which dies with the page.
  if (bytes.length <= INLINE_PREVIEW_MAX_BYTES) {
    attachment.url = `data:${attachment.contentType};base64,${base64}`;
  }
  return { param, attachment };
}

export interface AttachmentResolverOptions {
  rpc: JsonRpcClient;
  /** Object URLs kept alive at once; the oldest are revoked beyond this. */
  maxEntries?: number;
  /** Refuse to pull files larger than this through JSON (base64 inflates by a third). */
  maxBytes?: number;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

export class AttachmentResolver {
  private readonly cache = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  /** Bumped by clear() so late downloads from a previous session are discarded. */
  private generation = 0;

  constructor(private readonly options: AttachmentResolverOptions) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl =
      options.revokeObjectUrl ??
      ((url) => {
        URL.revokeObjectURL(url);
      });
  }

  /** `scope` narrows the lookup (`recipient` or `groupId`), as getAttachment allows. */
  resolve(attachment: Attachment, scope: RpcParams = {}): Promise<string> {
    if (attachment.url) return Promise.resolve(attachment.url);
    const cached = this.cache.get(attachment.id);
    if (cached) {
      // Refresh LRU position.
      this.cache.delete(attachment.id);
      this.cache.set(attachment.id, cached);
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(attachment.id);
    if (pending) return pending;
    if (attachment.size !== undefined && attachment.size > this.maxBytes) {
      return Promise.reject(
        new SignalCliError('user', 'Attachment is too large to open here; open it on your phone.'),
      );
    }
    const generation = this.generation;
    const promise = this.download(attachment, scope)
      .then((url) => {
        if (generation !== this.generation) {
          this.revokeObjectUrl(url);
          throw new SignalCliError('aborted', 'Disconnected while downloading the attachment');
        }
        this.remember(attachment.id, url);
        return url;
      })
      .finally(() => {
        this.inFlight.delete(attachment.id);
      });
    this.inFlight.set(attachment.id, promise);
    return promise;
  }

  /** Revokes every object URL (on disconnect/dispose). */
  clear(): void {
    this.generation++;
    for (const url of this.cache.values()) this.revokeObjectUrl(url);
    this.cache.clear();
    this.inFlight.clear();
  }

  private async download(attachment: Attachment, scope: RpcParams): Promise<string> {
    const { data } = await this.options.rpc.call(
      'getAttachment',
      { id: attachment.id, ...scope },
      wireAttachmentData,
      // Large files take a while to base64 through JSON.
      { timeoutMs: 120_000 },
    );
    const blob = new Blob([base64ToBytes(data)], { type: attachment.contentType });
    return this.createObjectUrl(blob);
  }

  private remember(id: string, url: string): void {
    this.cache.set(id, url);
    while (this.cache.size > this.maxEntries) {
      const [oldestId, oldestUrl] = this.cache.entries().next().value ?? [];
      if (oldestId === undefined || oldestUrl === undefined) break;
      this.cache.delete(oldestId);
      this.revokeObjectUrl(oldestUrl);
    }
  }
}
