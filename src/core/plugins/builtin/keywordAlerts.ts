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

import type { Message } from '@/core/domain';
import type { ComponentLike, MessageSlotProps } from '../registries';

export interface KeywordAlertsUi {
  /**
   * Builds the decoration shown next to the author of a matching message.
   * Receives the matcher so the component stays in sync with the settings.
   */
  highlight?: (matcher: (message: Message) => string | null) => ComponentLike<MessageSlotProps>;
  /** CSS injected while highlighting is on (e.g. tinting the matching row). */
  highlightCss?: string;
}

/**
 * Keyword Alerts. Headless by default (toast + notification booster); the
 * app passes the UI half (a decoration component) so core stays React-free.
 */
export function createKeywordAlertsPlugin(ui: KeywordAlertsUi = {}) {
  return definePlugin({
    id: 'keyword-alerts',
    name: 'Keyword Alerts',
    description:
      'Get notified when someone says a word you care about, even in muted or mentions-only conversations.',
    authors: ['snowdrop'],
    tags: ['notifications', 'messages'],
    settings: defineSettings({
      keywords: {
        type: 'string',
        label: 'Keywords',
        description: 'Comma-separated words or phrases. Matching ignores case.',
        default: '',
        placeholder: 'deploy, lunch, climbing',
      },
      highlight: {
        type: 'boolean',
        label: 'Highlight matching messages',
        description: 'Tints matching messages and shows the keyword next to the author.',
        default: true,
      },
      toast: {
        type: 'boolean',
        label: 'In-app toast',
        description: 'Also show a toast inside Snowdrop when a keyword comes up.',
        default: true,
      },
    }),
    start(ctx) {
      const selfId = () => ctx.stores.session.getState().self?.id;
      const matcher = (message: Message): string | null => {
        if (message.authorId === selfId() || message.kind !== 'normal' || message.deleted)
          return null;
        return matchKeyword(message.body, ctx.settings.get('keywords').split(','));
      };
      ctx.notifications.addBooster((message) => {
        const hit = matcher(message);
        return hit ? `Keyword “${hit}”` : null;
      });
      // Same rule as desktop notifications: nothing for what you're looking at.
      const viewing = (id: string) => {
        const ui = ctx.stores.ui.getState();
        return (
          ui.windowFocused &&
          ui.selectedConversationBySpace[ui.selectedSpace] === id &&
          ui.scrolledUp[id as keyof typeof ui.scrolledUp] !== true
        );
      };
      ctx.backend.onMessage((message) => {
        if (!ctx.settings.get('toast')) return;
        const hit = matcher(message);
        if (!hit || viewing(message.conversationId)) return;
        const conv = ctx.stores.conversations.getState().byId[message.conversationId];
        ctx.toast(`“${hit}” mentioned in ${conv?.title ?? 'a conversation'}`, 'info');
      });

      // Highlight UI follows its setting live.
      let undo: (() => void)[] = [];
      const sync = (on: boolean) => {
        for (const fn of undo) fn();
        undo = [];
        if (!on) return;
        if (ui.highlight) undo.push(ctx.messages.addDecoration('keyword', ui.highlight(matcher)));
        if (ui.highlightCss) undo.push(ctx.styles.inject(ui.highlightCss, 'highlight'));
      };
      sync(ctx.settings.get('highlight'));
      let last = ctx.settings.get('highlight');
      ctx.settings.subscribe((values) => {
        if (values.highlight !== last) sync((last = values.highlight));
      });
    },
  });
}

export const keywordAlertsPlugin = createKeywordAlertsPlugin();
