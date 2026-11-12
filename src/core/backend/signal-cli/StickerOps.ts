/**
 * Sticker operations over signal-cli: resolving a sticker's file, listing and
 * reading packs, installing one, and retaining/releasing the cached URLs.
 * SignalCliBackend delegates its `ChatBackend` sticker methods here.
 */
import type { StickerContent } from '@/core/domain';
import { createLogger, ignored } from '@/core/lib';
import type { StickerPackDetails, StickerPackInfo, StickerPackSticker } from '../types';
import { stickerCacheId, type AttachmentResolver } from './attachments';
import { SignalCliError } from './errors';
import type { JsonRpcClient } from './rpc';
import { unknownValue } from './validate';
import { wireStickerPacks, type WireStickerPack } from './wire';

const log = createLogger('signal-cli');

/** For commands whose result we don't need (it varies across daemons). */
const ignoreResult = unknownValue;

/** A sticker pack id as signal-cli prints it: hex. */
const HEX_ID = /^[\da-f]+$/u;

export interface StickerOpsDeps {
  rpc: JsonRpcClient;
  attachments: AttachmentResolver;
  /** Throws unless an account is selected. */
  assertAccount: () => void;
  /** Whether the connected daemon can register a history sticker's pack key. */
  historyStickerPackSupported: () => boolean;
  /** Whether the connected daemon can install a known sticker pack. */
  canInstallPack: () => boolean;
}

export class StickerOps {
  /** Installed packs whose download `listStickerPacks` already started this session. */
  private readonly stickerPacksFetchTried = new Set<string>();

  constructor(private readonly deps: StickerOpsDeps) {}

  private get rpc(): JsonRpcClient {
    return this.deps.rpc;
  }

  /**
   * See `ChatBackend.resolveStickerUrl`. When the pack isn't known locally —
   * typical for a sticker that only ever arrived through an imported
   * history archive — and this build can register one (patches/signal-cli's
   * "0016"), registers it from the backup's own copy of the key first.
   * Registration asks signal-cli to resolve `backupAttachment.id` itself
   * (the same opaque history id `getAttachment` already accepts); the key
   * never crosses this RPC boundary.
   *
   * Then retries `getSticker`, bounded: a daemon without patch 0016
   * (< history.16) downloads a not-yet-fetched pack on the first call that
   * needs it and still fails that call, so one more call (two after a fresh
   * registration, whose first `getSticker` was the one that failed) is what
   * actually works there. A current daemon just succeeds on the first retry.
   * Failures log the stage and error kind/code only.
   */
  async resolveStickerUrl(
    sticker: StickerContent,
    options?: { forceRefresh?: boolean },
  ): Promise<string> {
    this.deps.assertAccount();
    let first: unknown;
    try {
      return await this.deps.attachments.resolveSticker(sticker, options);
    } catch (error) {
      first = error;
    }
    let retries = 1;
    const supported = this.deps.historyStickerPackSupported();
    let registration: 'unsupported' | 'no-backup' | 'ok' | 'failed' = !supported
      ? 'unsupported'
      : sticker.backupAttachment
        ? 'ok'
        : 'no-backup';
    if (supported && sticker.backupAttachment) {
      try {
        await this.rpc.call(
          'registerHistoryStickerPack',
          { id: sticker.backupAttachment.id },
          ignoreResult,
        );
        retries = 2;
      } catch (error) {
        const { kind, code } = error as { kind?: unknown; code?: unknown };
        log.warn('sticker pack registration failed', {
          ...(typeof kind === 'string' ? { kind } : {}),
          ...(typeof code === 'number' ? { code } : {}),
        });
        registration = 'failed';
        logStickerFailure(registration, first, first);
        throw first; // The original error names the real cause.
      }
    }
    let last: unknown = first;
    for (let i = 0; i < retries; i++) {
      try {
        return await this.deps.attachments.resolveSticker(sticker, options);
      } catch (error) {
        // Keep the first error to throw; it's the one that names the real cause.
        last = error;
      }
    }
    logStickerFailure(registration, first, last);
    throw first;
  }

  /**
   * See `ChatBackend.listStickerPacks`. `listStickerPacks` lists every pack
   * the account knows — including history-registered ones that aren't
   * installed (patch 0016), which are left out — and an installed pack whose
   * files were never downloaded (it arrived through storage sync) lists with
   * no stickers. `getSticker` downloads a whole pack as a side effect (the
   * same local download `resolveStickerUrl` relies on; no install, no sync
   * to the phone), so one call per such pack and a second listing fill them
   * in. The result of that call is ignored: a daemon without patch 0016
   * downloads the pack and still throws on the first one.
   */
  async listStickerPacks(): Promise<StickerPackInfo[]> {
    this.deps.assertAccount();
    const list = (): Promise<WireStickerPack[]> =>
      this.rpc.call('listStickerPacks', {}, wireStickerPacks);
    let packs = (await list()).filter((p) => p.installed);
    // Each not-yet-downloaded pack is fetched once per session: one that
    // can't be (removed from the CDN, offline) mustn't stall every open.
    const unfetched = packs.filter(
      (p) => p.stickers.length === 0 && !this.stickerPacksFetchTried.has(p.packId),
    );
    if (unfetched.length > 0) {
      for (const p of unfetched) this.stickerPacksFetchTried.add(p.packId);
      await Promise.all(
        unfetched.map((p) =>
          this.rpc
            .call('getSticker', { packId: p.packId, stickerId: 0 }, ignoreResult, {
              timeoutMs: 30_000,
            })
            .catch(ignored('pack fetch is best effort; the pack listing decides what exists')),
        ),
      );
      packs = (await list()).filter((p) => p.installed);
    }
    return packs
      .flatMap((p): StickerPackInfo[] => {
        if (p.stickers.length === 0 || !/^[\da-f]+$/u.test(p.packId)) return [];
        const stickers = p.stickers.map((s): StickerPackSticker => ({
          stickerId: s.id,
          emoji: s.emoji,
        }));
        const cover = p.cover ?? p.stickers[0];
        return [
          {
            packId: p.packId,
            title: p.title,
            author: p.author,
            cover: { stickerId: cover?.id ?? 0, emoji: cover?.emoji ?? '' },
            stickers,
          },
        ];
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * See `ChatBackend.getStickerPack`. First makes sure the account knows the
   * pack and has downloaded it, the same way showing the sticker does
   * (`resolveStickerUrl`: registers a history sticker's pack via 0016, then
   * `getSticker` downloads the whole pack as a side effect; no install, no
   * sync). That call's outcome is ignored here: the listing below is the
   * judge of whether the pack is usable. Unlike `listStickerPacks`, an
   * uninstalled pack is returned (with `installed: false`).
   */
  async getStickerPack(sticker: StickerContent): Promise<StickerPackDetails> {
    this.deps.assertAccount();
    if (!HEX_ID.test(sticker.packId))
      throw new SignalCliError('user', "This sticker pack can't be shown.");
    await this.resolveStickerUrl(sticker).catch(
      ignored('the sticker download is best effort; the pack listing below decides what exists'),
    );
    const pack = (await this.rpc.call('listStickerPacks', {}, wireStickerPacks)).find(
      (p) => p.packId === sticker.packId,
    );
    if (!pack || pack.stickers.length === 0)
      throw new SignalCliError('user', 'This sticker pack is not available.');
    const cover = pack.cover ?? pack.stickers[0];
    return {
      packId: pack.packId,
      title: pack.title,
      author: pack.author,
      installed: pack.installed,
      cover: { stickerId: cover?.id ?? 0, emoji: cover?.emoji ?? '' },
      stickers: pack.stickers.map((s): StickerPackSticker => ({ stickerId: s.id, emoji: s.emoji })),
    };
  }

  /**
   * See `ChatBackend.installStickerPack`. A history sticker's pack is
   * registered first (0016, from the backup frame's own key) when this
   * build can, since `installKnownStickerPack` only knows packs the sticker
   * store already holds. Only the hex pack id crosses the RPC boundary; the
   * key is looked up by signal-cli itself.
   */
  async installStickerPack(sticker: StickerContent): Promise<void> {
    this.deps.assertAccount();
    if (!this.deps.canInstallPack())
      throw new SignalCliError('user', 'Installing sticker packs needs a newer signal-cli.');
    if (!HEX_ID.test(sticker.packId))
      throw new SignalCliError('user', "This sticker pack can't be installed.");
    if (this.deps.historyStickerPackSupported() && sticker.backupAttachment) {
      await this.rpc.call(
        'registerHistoryStickerPack',
        { id: sticker.backupAttachment.id },
        ignoreResult,
      );
    }
    await this.rpc.call('installKnownStickerPack', { packId: sticker.packId }, ignoreResult, {
      timeoutMs: 60_000,
    });
    // The listing the picker reads changes now; the next one re-fetches.
    this.stickerPacksFetchTried.delete(sticker.packId);
  }

  retainStickerUrl(sticker: StickerContent): void {
    this.deps.attachments.retain(stickerCacheId(sticker));
  }

  releaseStickerUrl(sticker: StickerContent): void {
    this.deps.attachments.release(stickerCacheId(sticker));
  }
}

/**
 * Why a `getSticker` call failed, from signal-cli's own message prefix —
 * never the message itself, which names the pack and sticker ids.
 */
function stickerFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Could not find sticker')) return 'not-found';
  if (message.startsWith('An error occurred reading sticker')) return 'read-error';
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : 'unknown';
}

/** One diagnostic line per sticker that couldn't be fetched (no ids or keys). */
function logStickerFailure(registration: string, first: unknown, last: unknown): void {
  const code = (first as { code?: unknown } | null)?.code;
  log.warn('sticker fetch failed', {
    registration,
    first: stickerFailureReason(first),
    last: stickerFailureReason(last),
    ...(typeof code === 'number' ? { code } : {}),
  });
}
