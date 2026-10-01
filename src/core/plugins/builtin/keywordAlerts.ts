import { definePlugin } from '../types';
import { defineSettings } from '../settings';

/** Case-insensitive whole-word match; returns the first keyword found. */
export function matchKeyword(text: string, keywords: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const raw of keywords) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(lower))
      return raw.trim();
  }
  return null;
}

export const keywordAlertsPlugin = definePlugin({
  id: 'keyword-alerts',
  name: 'Keyword Alerts',
  description: 'Get notified when someone says a word you care about.',
  authors: ['shrike'],
  tags: ['notifications'],
  settings: defineSettings({
    keywords: {
      type: 'string',
      label: 'Keywords',
      description: 'Comma-separated words or phrases.',
      default: '',
      placeholder: 'deploy, lunch, climbing',
    },
    highlight: {
      type: 'boolean',
      label: 'Highlight matching messages',
      default: true,
    },
  }),
  start(ctx) {
    ctx.backend.onMessage((message) => {
      const selfId = ctx.stores.session.getState().self?.id;
      if (message.authorId === selfId || message.kind !== 'normal') return;
      const keywords = ctx.settings.get('keywords').split(',');
      const hit = matchKeyword(message.body, keywords);
      if (!hit) return;
      const conv = ctx.stores.conversations.getState().byId[message.conversationId];
      ctx.toast(`“${hit}” mentioned in ${conv?.title ?? 'a conversation'}`, 'info');
    });
    // TODO(P4): message highlight decoration + desktop notification via NotificationService.
  },
});
