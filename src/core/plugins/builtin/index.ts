import type { PluginDefinition } from '../types';
import { clearUrlsPlugin } from './clearUrls';
import { keywordAlertsPlugin } from './keywordAlerts';
import { slashBasicsPlugin } from './slashBasics';

export { clearUrlsPlugin, cleanUrl, stripTrackingParams } from './clearUrls';
export {
  createKeywordAlertsPlugin,
  keywordAlertsPlugin,
  matchKeyword,
  type KeywordAlertsUi,
} from './keywordAlerts';
export { slashBasicsPlugin } from './slashBasics';
export { charCount, wordCount } from './messageText';

/**
 * Headless built-ins. Plugins whose value is visual (Relative Timestamps,
 * Message Tools, Contact Notes badge) live in ui/plugins and are added by the
 * composition root, which also gives Keyword Alerts its highlight UI.
 */
export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [
  clearUrlsPlugin,
  slashBasicsPlugin,
  keywordAlertsPlugin,
];
