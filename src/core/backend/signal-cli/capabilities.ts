/**
 * The one place that decides whether a running signal-cli build can deliver
 * Snowdrop's custom-emoji extension (patches/signal-cli, "Custom emoji").
 * Nothing upstream advertises this, so it's inferred from signal-cli's own
 * version string: a Snowdrop-patched build names itself `snowdrop-history.N`
 * (the patch set's own monotonic counter, not a feature-specific name — see
 * patches/signal-cli/README.md), and this feature needs patch level 10 or
 * later. Upstream signal-cli, the demo backend, or an older patched build
 * all fail this check, and Snowdrop falls back to plain `:name:` text.
 */
const SNOWDROP_PATCH_LEVEL = /snowdrop-history\.(\d+)/u;

/** The lowest `snowdrop-history.N` patch level that can deliver custom emoji. */
export const MIN_CUSTOM_EMOJI_PATCH_LEVEL = 10;

export function supportsCustomEmojiDelivery(version: string | undefined): boolean {
  if (!version) return false;
  const match = SNOWDROP_PATCH_LEVEL.exec(version);
  if (!match?.[1]) return false;
  return Number(match[1]) >= MIN_CUSTOM_EMOJI_PATCH_LEVEL;
}
