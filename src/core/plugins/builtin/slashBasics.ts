import { escapeMarkdown } from '@/core/domain';
import { definePlugin } from '../types';

// Escaped so the markdown pass doesn't eat the backslash or italicise "_(ツ)_".
const SHRUG = escapeMarkdown('¯\\_(ツ)_/¯');
const TABLEFLIP = escapeMarkdown('(╯°□°)╯︵ ┻━┻');
const UNFLIP = escapeMarkdown('┬─┬ノ( º _ ºノ)');

const withText = (args: string, face: string): string => (args ? `${args} ${face}` : face);

export const slashBasicsPlugin = definePlugin({
  id: 'slash-basics',
  name: 'Slash Basics',
  description: 'Adds /shrug, /tableflip, /unflip, /me and /spoiler.',
  authors: ['hearth'],
  tags: ['fun', 'composer'],
  enabledByDefault: true,
  start(ctx) {
    ctx.slash.register({
      name: 'shrug',
      description: 'Appends ¯\\_(ツ)_/¯ to your message.',
      usage: '[message]',
      execute: (args) => ({ type: 'send', text: withText(args, SHRUG) }),
    });
    ctx.slash.register({
      name: 'tableflip',
      description: 'Appends (╯°□°)╯︵ ┻━┻ to your message.',
      usage: '[message]',
      execute: (args) => ({ type: 'send', text: withText(args, TABLEFLIP) }),
    });
    ctx.slash.register({
      name: 'unflip',
      description: 'Appends ┬─┬ノ( º _ ºノ) to your message.',
      usage: '[message]',
      execute: (args) => ({ type: 'send', text: withText(args, UNFLIP) }),
    });
    ctx.slash.register({
      name: 'me',
      description: 'Sends an action in italics.',
      usage: '<action>',
      execute: (args) =>
        args
          ? { type: 'send', text: `_${args}_` }
          : { type: 'error', message: 'Usage: /me <action>' },
    });
    ctx.slash.register({
      name: 'spoiler',
      description: 'Sends your message as a spoiler.',
      usage: '<message>',
      execute: (args) =>
        args
          ? { type: 'send', text: `||${args}||` }
          : { type: 'error', message: 'Usage: /spoiler <message>' },
    });
  },
});
