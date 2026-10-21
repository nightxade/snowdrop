/**
 * The one place that decides whether a running signal-cli build can deliver
 * Snowdrop's custom-emoji extension (patches/signal-cli, "Custom emoji").
 * Nothing upstream advertises this, so it's inferred from signal-cli's own
 * version string: a Snowdrop-patched build names itself `snowdrop-history.N`
 * (the patch set's own monotonic counter, not a feature-specific name — see
 * patches/signal-cli/README.md), and this feature needs patch level 11 or
 * later. Patch level 10 can *send* custom emoji but can't properly receive
 * them (it never serialized the decoded emoji to JSON-RPC and never
 * downloaded their attachments, so `getAttachment` would fail for their
 * id) — patch level 11 fixes both. Upstream signal-cli, the demo backend,
 * or an older patched build all fail this check, and Snowdrop falls back
 * to plain `:name:` text.
 */
const SNOWDROP_PATCH_LEVEL = /snowdrop-history\.(\d+)/u;

/** The lowest `snowdrop-history.N` patch level that can deliver custom emoji. */
export const MIN_CUSTOM_EMOJI_PATCH_LEVEL = 11;

export function supportsCustomEmojiDelivery(version: string | undefined): boolean {
  if (!version) return false;
  const match = SNOWDROP_PATCH_LEVEL.exec(version);
  if (!match?.[1]) return false;
  return Number(match[1]) >= MIN_CUSTOM_EMOJI_PATCH_LEVEL;
}

/**
 * Whether a running signal-cli build implements `requestAttachmentBackfill`
 * and the `attachmentBackfill` notification (patches/signal-cli, "0016:
 * attachment backfill"). Signal-cli's own capability advertisement
 * (`attachmentBackfill = !isPrimaryDevice`) predates this patch and is
 * unconditional on *any* build, patched or not, so it can't be used to
 * detect support here — only the version string can. Same
 * `snowdrop-history.N` scheme as custom emoji, just a different threshold.
 */
export const MIN_ATTACHMENT_BACKFILL_PATCH_LEVEL = 14;

export function supportsAttachmentBackfill(version: string | undefined): boolean {
  if (!version) return false;
  const match = SNOWDROP_PATCH_LEVEL.exec(version);
  if (!match?.[1]) return false;
  return Number(match[1]) >= MIN_ATTACHMENT_BACKFILL_PATCH_LEVEL;
}

/**
 * Whether a running signal-cli build implements `registerHistoryStickerPack`
 * (patches/signal-cli, "0019: history sticker pack"). Without it, a sticker
 * that only ever arrived through an imported history archive can't be
 * fetched unless this device also received it live; Snowdrop falls back to
 * the archive's own backup copy, then the emoji. Same `snowdrop-history.N`
 * scheme as the other capabilities.
 */
export const MIN_HISTORY_STICKER_PACK_PATCH_LEVEL = 15;

export function supportsHistoryStickerPack(version: string | undefined): boolean {
  if (!version) return false;
  const match = SNOWDROP_PATCH_LEVEL.exec(version);
  if (!match?.[1]) return false;
  return Number(match[1]) >= MIN_HISTORY_STICKER_PACK_PATCH_LEVEL;
}

/**
 * Whether a running signal-cli build implements `installKnownStickerPack`
 * (patches/signal-cli, "0021: install a known sticker pack"): the explicit,
 * user-asked "Install" for a pack seen in a received sticker, by pack id
 * alone (the key never leaves signal-cli). Without it the pack dialog can
 * still show the pack but its Install button stays disabled. Same
 * `snowdrop-history.N` scheme as the other capabilities.
 */
export const MIN_STICKER_PACK_INSTALL_PATCH_LEVEL = 17;

export function supportsStickerPackInstall(version: string | undefined): boolean {
  if (!version) return false;
  const match = SNOWDROP_PATCH_LEVEL.exec(version);
  if (!match?.[1]) return false;
  return Number(match[1]) >= MIN_STICKER_PACK_INSTALL_PATCH_LEVEL;
}

/**
 * Whether a running signal-cli build implements `getConfiguration` and the
 * `receiveConfigurationChanged` notification (patches/signal-cli, "0022:
 * privacy configuration"): the read receipts / typing indicators / link
 * previews the user's phone syncs to this device. Without it Snowdrop can't
 * follow the phone and keeps using its own local settings. Same
 * `snowdrop-history.N` scheme as the other capabilities.
 */
export const MIN_PHONE_PRIVACY_PATCH_LEVEL = 18;

export function supportsPhonePrivacy(version: string | undefined): boolean {
  if (!version) return false;
  const match = SNOWDROP_PATCH_LEVEL.exec(version);
  if (!match?.[1]) return false;
  return Number(match[1]) >= MIN_PHONE_PRIVACY_PATCH_LEVEL;
}

/**
 * Whether a running signal-cli build can send only the own-device read sync
 * for `sendReceipt` (`syncOnly`; patches/signal-cli, "0023: sync-only read
 * receipts"), so reading marks messages read on the user's phone even when
 * no receipt may go to the sender. Without it Snowdrop keeps the older
 * behaviour: nothing at all is sent when a receipt isn't allowed. Same
 * `snowdrop-history.N` scheme as the other capabilities.
 */
export const MIN_READ_SYNC_PATCH_LEVEL = 19;

export function supportsReadSync(version: string | undefined): boolean {
  if (!version) return false;
  const match = SNOWDROP_PATCH_LEVEL.exec(version);
  if (!match?.[1]) return false;
  return Number(match[1]) >= MIN_READ_SYNC_PATCH_LEVEL;
}
