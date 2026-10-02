import { ClipboardCopy, Sigma } from 'lucide-react';
import type { Message } from '@/core/domain';
import { charCount, definePlugin, defineSettings, type PluginContext } from '@/core/plugins';
import { wordCount } from '@/core/plugins';
import { UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { toMarkdown } from '@/ui/features/chat';

const settings = defineSettings({
  hoverCopy: {
    type: 'boolean',
    label: 'Copy as Markdown in the hover bar',
    default: true,
  },
  hoverCount: {
    type: 'boolean',
    label: 'Word count in the hover bar',
    description: 'Word count is always available from the message menu.',
    default: true,
  },
});

const hasText = (m: Message) => !m.deleted && m.kind === 'normal' && m.body.trim() !== '';

function copyMarkdown(ctx: PluginContext<typeof settings>, m: Message): void {
  const contacts = ctx.stores.contacts.getState().byId;
  const { text } = toMarkdown(m.body, m.ranges, (id) => contacts[id]?.name ?? UNKNOWN_CONTACT_NAME);
  navigator.clipboard.writeText(text).then(
    () => {
      ctx.toast('Copied as Markdown', 'success');
    },
    () => {
      ctx.toast('Couldn’t reach the clipboard', 'error');
    },
  );
}

function announceCount(ctx: PluginContext<typeof settings>, m: Message): void {
  const words = wordCount(m.body);
  const chars = charCount(m.body);
  ctx.toast(
    `${words.toLocaleString()} word${words === 1 ? '' : 's'} · ${chars.toLocaleString()} character${chars === 1 ? '' : 's'}`,
    'info',
  );
}

export const messageToolsPlugin = definePlugin({
  id: 'message-tools',
  name: 'Message Tools',
  description: 'Adds “Copy as Markdown” and a word count to the message hover bar and menu.',
  authors: ['shrike'],
  tags: ['messages'],
  settings,
  start(ctx) {
    ctx.messages.addHoverAction({
      id: 'copy-markdown',
      label: 'Copy as Markdown',
      icon: ClipboardCopy,
      visible: (m) => hasText(m) && ctx.settings.get('hoverCopy'),
      onClick: (m) => {
        copyMarkdown(ctx, m);
      },
    });
    ctx.messages.addHoverAction({
      id: 'word-count',
      label: 'Word count',
      icon: Sigma,
      visible: (m) => hasText(m) && ctx.settings.get('hoverCount'),
      onClick: (m) => {
        announceCount(ctx, m);
      },
    });
    ctx.menus.add('message', {
      id: 'word-count',
      label: 'Word count',
      icon: Sigma,
      visible: hasText,
      onSelect: (m) => {
        announceCount(ctx, m);
      },
    });
  },
});
