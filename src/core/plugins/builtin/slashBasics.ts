import { escapeMarkdown } from '@/core/domain';
import { defineExtension } from '../types';

// Escaped so the markdown pass doesn't eat the backslash or italicise "_(ツ)_".
const SHRUG = escapeMarkdown('¯\\_(ツ)_/¯');
const TABLEFLIP = escapeMarkdown('(╯°□°)╯︵ ┻━┻');
const UNFLIP = escapeMarkdown('┬─┬ノ( º _ ºノ)');

const withText = (args: string, face: string): string => (args ? `${args} ${face}` : face);

/** Our output is markdown (escaped faces, _me_, ||spoiler||) whatever the user's setting. */
const send = (text: string) => ({ type: 'send', text, format: 'markdown' }) as const;

export const slashBasicsPlugin = defineExtension({
  id: 'slash-basics',
  name: 'Slash Basics',
  description: 'Adds /shrug, /tableflip, /unflip, /me and /spoiler.',
  authors: ['snowdrop'],
  tags: ['fun', 'composer'],
  enabledByDefault: true,
  start(ctx) {
    ctx.slash.register({
      name: 'shrug',
      description: 'Appends ¯\\_(ツ)_/¯ to your message.',
      usage: '[message]',
      execute: (args) => send(withText(args, SHRUG)),
    });
    ctx.slash.register({
      name: 'tableflip',
      description: 'Appends (╯°□°)╯︵ ┻━┻ to your message.',
      usage: '[message]',
      execute: (args) => send(withText(args, TABLEFLIP)),
    });
    ctx.slash.register({
      name: 'unflip',
      description: 'Appends ┬─┬ノ( º _ ºノ) to your message.',
      usage: '[message]',
      execute: (args) => send(withText(args, UNFLIP)),
    });
    ctx.slash.register({
      name: 'me',
      description: 'Sends an action in italics.',
      usage: '<action>',
      // "/me waves" → "_Juniper waves_": the action reads as yours in any client.
      execute: (args) => {
        if (!args) return { type: 'error', message: 'Usage: /me <action>' };
        const name = ctx.stores.session.getState().self?.name;
        return send(`_${name ? `${escapeMarkdown(name)} ` : ''}${args}_`);
      },
    });
    ctx.slash.register({
      name: 'spoiler',
      description: 'Sends your message as a spoiler.',
      usage: '<message>',
      execute: (args) =>
        args ? send(`||${args}||`) : { type: 'error', message: 'Usage: /spoiler <message>' },
    });
  },
});
