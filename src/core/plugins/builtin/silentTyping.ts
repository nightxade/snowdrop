import { definePlugin } from '../types';

export const silentTypingPlugin = definePlugin({
  id: 'silent-typing',
  name: 'Silent Typing',
  description: 'Never tell others when you are typing.',
  authors: ['shrike'],
  tags: ['privacy'],
  start(ctx) {
    ctx.send.addTypingGuard(() => false);
  },
});
