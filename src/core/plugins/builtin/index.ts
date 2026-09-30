import type { PluginDefinition } from '../types';
import { clearUrlsPlugin } from './clearUrls';
import { keywordAlertsPlugin } from './keywordAlerts';
import { messageToolsPlugin, relativeTimestampsPlugin } from './previews';
import { silentTypingPlugin } from './silentTyping';
import { slashBasicsPlugin } from './slashBasics';

export { clearUrlsPlugin, cleanUrl, stripTrackingParams } from './clearUrls';
export { keywordAlertsPlugin, matchKeyword } from './keywordAlerts';
export { silentTypingPlugin } from './silentTyping';
export { slashBasicsPlugin } from './slashBasics';
export { relativeTimestampsPlugin, messageToolsPlugin } from './previews';

export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [
  clearUrlsPlugin,
  silentTypingPlugin,
  slashBasicsPlugin,
  keywordAlertsPlugin,
  relativeTimestampsPlugin,
  messageToolsPlugin,
];
