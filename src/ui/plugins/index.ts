/**
 * Built-in plugins with a UI half. Core built-ins are React-free; these add
 * components (decorations, hover-action icons), so they live in ui/ and the
 * composition root merges them with the headless ones.
 */
import { createKeywordAlertsPlugin, type PluginDefinition } from '@/core/plugins';
import { contactNotesBadgePlugin } from './ContactNotesBadge';
import { KEYWORD_HIGHLIGHT_CSS, makeKeywordChip } from './KeywordHighlight';
import { messageToolsPlugin } from './MessageTools';
import { relativeTimestampsPlugin } from './RelativeTimestamps';

export { noteBadgeText } from './ContactNotesBadge';

export const UI_PLUGINS: readonly PluginDefinition[] = [
  relativeTimestampsPlugin,
  messageToolsPlugin,
  contactNotesBadgePlugin,
];

/** Headless built-ins with their UI attached, plus the UI-only built-ins. */
export function withUiPlugins(builtins: readonly PluginDefinition[]): PluginDefinition[] {
  const keywordAlerts = createKeywordAlertsPlugin({
    highlight: makeKeywordChip,
    highlightCss: KEYWORD_HIGHLIGHT_CSS,
  });
  return [...builtins.map((p) => (p.id === keywordAlerts.id ? keywordAlerts : p)), ...UI_PLUGINS];
}
