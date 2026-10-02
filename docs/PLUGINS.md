# Writing plugins

Shrike's features are extended through typed **extension points**, never by
monkey-patching. A plugin is a plain object with a `start(ctx)` function; the
`ctx` it receives is the whole API. Everything a plugin registers is tracked
and undone when it stops, and a plugin that throws can't take the app down.

Several built-in features are plugins written against this same API (Clear
URLs, Slash Basics, Keyword Alerts, Relative Timestamps, Message Tools,
Pronoun & Notes Badge, Vim Mode), so the API is exercised by real code.

> **Plugins are compiled in.** There is no runtime loading of third-party code:
> a plugin lives in the source tree and is registered in a list (see
> [Registering a plugin](#registering-a-plugin)). Users turn plugins on and off
> in **Settings → Plugins** without a reload.

Contents: [Anatomy](#anatomy) · [Settings](#settings) ·
[Lifecycle](#lifecycle-and-auto-disposal) · [Capabilities](#capabilities) ·
[Error isolation](#error-isolation) · [Registering](#registering-a-plugin) ·
[Worked example](#worked-example-caps-guard) · [Conventions](#conventions)

## Anatomy

```ts
import { definePlugin, defineSettings } from '@/core/plugins';

export const clearUrlsPlugin = definePlugin({
  id: 'clear-urls', // stable, kebab-case: the settings key
  name: 'Clear URLs',
  description: 'Strips tracking parameters (utm_*, fbclid, …) from links you send.',
  authors: ['shrike'],
  tags: ['privacy', 'messages'], // shown on the card, clickable as a filter
  enabledByDefault: true, // on until the user first toggles it
  settings: defineSettings({
    extraParams: {
      type: 'string',
      label: 'Extra parameters',
      description: 'Comma-separated names to strip as well. End with * to match a prefix.',
      default: '',
      placeholder: 'ref, source_*',
    },
  }),
  start(ctx) {
    ctx.send.addTransform((draft) => ({
      ...draft,
      text: stripTrackingParams(draft.text, parseParamList(ctx.settings.get('extraParams'))),
    }));
  },
});
```

That is the real built-in (`src/core/plugins/builtin/clearUrls.ts`), helpers
elided. `PluginDefinition` fields:

| Field               | Meaning                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `id`                | Stable kebab-case id. Used as the key in `settings.plugins` and to attribute registrations. |
| `name`              | Card title.                                                                                 |
| `description`       | One sentence for the card.                                                                  |
| `authors`           | Byline (built-ins say `['shrike']`, shown as "Built in").                                   |
| `tags?`             | Lower-case tags for filtering.                                                              |
| `settings?`         | A schema from `defineSettings` (see below).                                                 |
| `enabledByDefault?` | Initial state before the user ever toggles the plugin (default `false`).                    |
| `required?`         | Core functionality built on the plugin API: always on, no switch.                           |
| `preview?`          | Not functional yet; shown as "coming soon".                                                 |
| `start(ctx)`        | Registers everything. May be `async`.                                                       |
| `stop?(ctx)`        | Optional extra cleanup, run before the automatic disposal. Rarely needed.                   |

`definePlugin` and `defineSettings` are identity functions. They exist for
type inference: with them, `ctx.settings.get('extraParams')` is typed `string`
and a typo in a key is a compile error.

## Settings

```ts
const settings = defineSettings({
  greeting: { type: 'string', label: 'Greeting', default: 'Hello' },
  loud: { type: 'boolean', label: 'Loud', default: false },
  size: { type: 'number', label: 'Size', default: 3, min: 1, max: 5, step: 1 },
  tone: {
    type: 'select',
    label: 'Tone',
    default: 'warm',
    options: [
      { value: 'warm', label: 'Warm' },
      { value: 'dry', label: 'Dry' },
    ],
  },
  seen: { type: 'boolean', label: 'Intro seen', default: false, hidden: true },
});

// in start(ctx):
const tone: 'warm' | 'dry' = ctx.settings.get('tone'); // literal union inferred
ctx.settings.set('size', 4);
ctx.settings.subscribe((values) => {
  ctx.log.info('settings now', values.size);
});
```

- Field types: `boolean`, `string` (`placeholder?`, `multiline?`,
  `maxLength?`), `number` (`min?`, `max?`, `step?`) and `select` (`options`).
  All take `label`, `description?` and `hidden?`.
- **The settings form is generated** from the schema (cog on the plugin card):
  boolean → switch; string → text field or textarea (`multiline`); number →
  slider when both `min` and `max` are set, else a number field; select →
  segmented control for up to 3 options, else a dropdown. `hidden` fields are
  internal state (Vim Mode's `introShown`) and never shown. The form has a
  "Reset to defaults" button.
- **Stored values are untrusted** (older versions, hand-edited storage).
  Every read goes through `coerceSetting`: wrong types fall back to the
  default, numbers are clamped to `min`/`max`, strings cut to `maxLength`,
  unknown select values fall back. `set` coerces too.
- `ctx.settings.all()` returns every value; `subscribe` fires with fresh
  values whenever _this plugin's_ settings change (and is auto-disposed).
- Changing a plugin's settings never restarts it. Read settings when you need
  them (`ctx.settings.get` in the transform, as above) or subscribe.

## Lifecycle and auto-disposal

- The `PluginRuntime` starts every enabled plugin after the initial sync
  (`shrike.start()`), then follows the settings store: toggling a plugin
  anywhere (its card, a settings reset, an import) starts or stops exactly
  that plugin, with no reload.
- Each start gets a fresh `PluginContext`. **Every registration returns a
  disposer and is tracked**; when the plugin stops, all of them are undone in
  one go (commands, slash commands, transforms, UI contributions, styles, key
  layers, store subscriptions made through `ctx.settings.subscribe` or
  `ctx.backend.onMessage`).
- For anything else — timers, DOM listeners, your own store subscriptions —
  use `ctx.onDispose(fn)`:

  ```ts
  const off = ctx.stores.conversations.subscribe((state, previous) => {
    if (state.byId !== previous.byId) ctx.log.info('conversations changed');
  });
  ctx.onDispose(off);
  ```

- You may call a disposer yourself to remove one registration early (e.g. a
  style that follows a setting, see Relative Timestamps); calling it again on
  stop is harmless.
- Start and stop are serialised per plugin, so a fast on/off/on can't
  interleave. `start` may be async; the plugin counts as running when it
  resolves.

## Capabilities

`PluginContext` (`src/core/plugins/types.ts`). UI contributions are React
components; core stores them as opaque values, and `ui/` renders them inside
per-plugin error boundaries.

| Capability                                  | What it does                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ctx.commands.register(command)`            | A command in the palette (`>` in the switcher), optionally with a default keybind. |
| `ctx.commands.execute(id)`                  | Runs any command by id, core ones included.                                        |
| `ctx.slash.register(command)`               | A `/command` in the composer, with autocomplete.                                   |
| `ctx.send.addTransform(fn)`                 | Rewrites outgoing drafts before they're sent.                                      |
| `ctx.send.addTypingGuard(fn)`               | Suppresses outgoing typing indicators per conversation.                            |
| `ctx.messages.addAccessory(id, Component)`  | Rendered under a message's body.                                                   |
| `ctx.messages.addDecoration(id, Component)` | Rendered next to the author name.                                                  |
| `ctx.messages.addHoverAction(action)`       | A button in the message hover bar.                                                 |
| `ctx.menus.add(location, item)`             | An item in a context menu.                                                         |
| `ctx.headerBar.addButton(button)`           | A button in the chat header.                                                       |
| `ctx.settingsPanels.add(panel)`             | A page under Settings → From plugins.                                              |
| `ctx.styles.inject(css, id?)`               | Global CSS while the plugin runs.                                                  |
| `ctx.notifications.addBooster(fn)`          | Marks messages as important (notify like a mention).                               |
| `ctx.keys.addLayer(layer)`                  | A modal key layer that sees keys before everything else.                           |
| `ctx.composer.addAccessory(id, Component)`  | Rendered inside the composer field.                                                |
| `ctx.toast(message, kind?)`                 | An in-app toast.                                                                   |
| `ctx.log.info / warn / error`               | Console logging prefixed with `[plugin:<id>]`.                                     |
| `ctx.stores`                                | Read-only access to every store.                                                   |
| `ctx.backend`                               | A narrow messaging facade.                                                         |
| `ctx.settings`                              | This plugin's typed settings (above).                                              |
| `ctx.onDispose(fn)`                         | Extra cleanup on stop.                                                             |
| `ctx.pluginId`                              | The plugin's id.                                                                   |

### Commands

```ts
ctx.commands.register({
  id: 'snippets.say-hello', // prefix with your plugin id; duplicates throw
  title: 'Snippets: say hello',
  category: 'Plugins', // palette grouping
  keybind: 'Mod+Alt+H', // optional default; users can rebind in Settings → Keybinds
  enabled: () => ctx.stores.session.getState().self !== null,
  run: () => {
    ctx.toast(`${ctx.settings.get('greeting')}!`, 'info');
  },
});

await ctx.commands.execute(CoreCommand.ToggleMemberList); // false if missing/disabled
```

Other `Command` fields: `allowInInputs` (fire even while typing in a text
field) and `hidden` (keep out of the palette). Keybinds are portable strings
where `Mod` is Cmd on macOS and Ctrl elsewhere. Core command ids are exported
from `@/core/commands`: `CoreCommand` (the default shortcuts), `NavCommand`
(focus composer/messages, next/previous space, command palette, open search)
and `MessageCommand` (next/previous/first/last message, scrolling, and
reply/edit/react/copy/delete/pin/open on the focused message). Vim Mode drives
the whole app through these ids.

### Slash commands

```ts
ctx.slash.register({
  name: 'roll', // lower-case, no slash; a name that already exists throws
  description: 'Rolls a die.',
  usage: '[sides]', // shown in autocomplete
  execute: (args) => {
    const sides = Number(args || 6);
    if (!Number.isInteger(sides) || sides < 2)
      return { type: 'error', message: 'Usage: /roll [sides]' };
    return { type: 'send', text: `🎲 ${1 + Math.floor(Math.random() * sides)} (d${sides})` };
  },
});
```

`execute(args, { conversationId })` gets the text after the name (trimmed) and
the conversation; it may be async and returns a `SlashResult`:

- `{ type: 'send', text, format? }` — send this instead. Set
  `format: 'markdown'` when your text relies on Markdown escaping, so it renders
  right even when the user turned Markdown off (Slash Basics does).
- `{ type: 'replace', text }` — put this in the composer for more editing.
- `{ type: 'error', message }` — show an inline error, keep the text.
- `{ type: 'done' }` — handled; clear the composer.

### Send transforms

```ts
ctx.send.addTransform((draft) => ({ ...draft, text: draft.text.replace(/\bteh\b/gu, 'the') }));
```

A transform receives an `OutgoingDraft` — `{ conversationId, text,
mentionIds, quote?, attachments, format? }` — and returns a new one (or a
promise of one). `text` is the raw composer text: Markdown not yet parsed, one
U+FFFC placeholder per mention, with `mentionIds` in the same order. Keep the
placeholders and ids in step if you edit around mentions. Transforms run in
registration order and must return a draft for the **same conversation**.

### Typing guard

```ts
// Never tell groups that you're typing.
ctx.send.addTypingGuard((conversationId) => !conversationId.startsWith('group:'));
```

Return `false` to suppress the indicator. Guards combine with the user's
"Send typing indicators" privacy setting; any `false` wins.

### Message accessories and decorations

```tsx
ctx.messages.addAccessory('char-count', ({ message }: { message: Message }) =>
  message.body.length > 500 ? <small>{message.body.length} characters</small> : null,
);

ctx.messages.addDecoration('bot-tag', ({ message }: { message: Message }) =>
  message.authorId === 'bot' ? <span>BOT</span> : null,
);
```

Both receive `{ message }`. Accessories render under the body (slot
`message.accessories`), decorations next to the author name and time in the
message header (slot `message.decorations`; continuation rows have no header,
so they show no decorations). Return `null` to render nothing. Components are
re-rendered when the message changes; to follow settings or other stores, use
`useSyncExternalStore` (see the worked example and
`src/ui/plugins/ContactNotesBadge.tsx`).

### Hover actions

```ts
ctx.messages.addHoverAction({
  id: 'remind',
  label: 'Remind me in an hour', // tooltip and accessible name
  icon: Timer, // any component that accepts { size }: lucide-react icons fit
  visible: (m) => m.kind === 'normal' && !m.deleted,
  onClick: (m) => {
    const t = setTimeout(() => {
      ctx.toast(`Reminder: ${m.body.slice(0, 60)}`, 'info');
    }, 3_600_000);
    ctx.onDispose(() => {
      clearTimeout(t);
    });
  },
});
```

The hover bar is not shown on touch layouts; offer the same action as a
message menu item so it stays reachable there and from the keyboard (Message
Tools does both).

### Menus

```ts
ctx.menus.add('message', {
  id: 'bookmark',
  label: 'Bookmark',
  icon: Bookmark,
  onSelect: (message) => {
    ctx.log.info(message.id);
  },
});
ctx.menus.add('conversation', {
  id: 'copy-title',
  label: 'Copy title',
  visible: (conversation) => conversation.kind === 'group',
  onSelect: (conversation) => {
    void navigator.clipboard.writeText(conversation.title);
  },
});
ctx.menus.add('space', {
  id: 'log-space',
  label: 'Log space id',
  onSelect: ({ spaceId }) => {
    ctx.log.info(spaceId);
  },
});
```

Locations and their targets (`MenuTargets`): `message` → `Message`,
`conversation` → `Conversation`, `space` → `{ spaceId }`, `member` →
`{ contact, conversationId }`. Items take `danger?` for destructive styling.
Plugin items appear after the built-in items. Note: the `member` location is
part of the API, but no member menu renders plugin items yet, and the
conversation menu does not show item icons.

### Header buttons

```ts
ctx.headerBar.addButton({
  id: 'members-count',
  label: 'How many members?',
  icon: Users,
  visible: (conversation) => conversation.kind === 'group',
  onClick: (conversation) => {
    ctx.toast(`${conversation.memberIds.length} members`, 'info');
  },
});
```

Rendered as icon buttons in the chat header (`[data-slot='chat.header.buttons']`).

### Settings panels

```tsx
ctx.settingsPanels.add({
  id: 'about-snippets',
  title: 'Snippets help',
  component: () => <p>Type /roll in any conversation.</p>,
});
```

A full settings page under **Settings → From plugins**, rendered with no
props; it is searchable by its title. Use it for things the generated form
can't express (Vim Mode's read-only key map). Ordinary options belong in the
schema.

### Styles

```ts
const unstyle = ctx.styles.inject(
  `[data-shrike='message'][data-mention] { outline: 1px dashed var(--shrike-accent); }`,
  'mentions', // optional id, shown in a comment in the generated CSS
);
```

All plugin CSS is concatenated in registration order into one
`<style id="shrike-plugins">`, after the theme and before the user's Custom
CSS (so users can override plugins). Target the stable `data-shrike` hooks and
`--shrike-*` tokens listed in [THEMING.md](THEMING.md), never hashed CSS-module
class names.

### Notification boosters

```ts
ctx.notifications.addBooster((message) =>
  /\burgent\b/iu.test(message.body) ? 'Marked urgent' : null,
);
```

Return a short reason (or `null`). A boosted message notifies like a mention:
also in mentions-only mode and in muted conversations or spaces. The first
non-null reason wins. Keyword Alerts is built on this.

### Key layers

```ts
import { KeySequencer, MessageCommand, parseKeySequence } from '@/core/commands';

const sequencer = new KeySequencer({
  bindings: [
    {
      keys: parseKeySequence('gm'),
      countable: false,
      run: () => void ctx.commands.execute(MessageCommand.Last),
    },
  ],
  timeoutMs: () => 1000,
});
ctx.keys.addLayer({
  id: 'snippets-keys',
  help: [{ title: 'Snippets', items: [{ keys: 'g m', title: 'Latest message' }] }],
  onKey: (stroke, keyCtx) => {
    if (keyCtx.overlay || (keyCtx.target !== 'list' && keyCtx.target !== 'message')) return false;
    return sequencer.feed(stroke.token, keyCtx) !== 'none';
  },
  dispose: () => {
    sequencer.reset();
  },
});
```

Layers see every key press in the capture phase, **before** keybinds and the
focused widget; the newest layer gets first refusal. Return `true` to consume
the key (the app calls `preventDefault` and `stopPropagation`). With no layer
installed the default keyboard map is untouched.

- `stroke.token` is Vim notation (`j`, `G`, `<C-d>`, `<Esc>`, `<CR>`),
  layout-aware like keybinds; `stroke.event` is the raw event.
- `keyCtx.target` is `'none' | 'list' | 'message' | 'composer' | 'input' |
'other'`; `keyCtx.overlay` is true while a dialog, menu or listbox is open
  (leave keys alone then); `keyCtx.surface` is a `TextSurface` when the
  composer has focus (`read`, `write`, `submit`, `escape`,
  `setSuggestionsEnabled`).
- IME composition and bare modifier presses never reach layers.
- `help` groups appear in the Ctrl+/ shortcut sheet while the layer is
  installed. `dispose` runs when the layer is removed.
- `KeySequencer` handles counts (`3j`), prefix sequences (`gg`) and the
  timeout; `parseKeySequence('<leader>s', leader)` reads bindings.

Vim Mode (`src/ui/plugins/vim/`) is the full-size example: a layer, a pure
editing engine, a composer accessory and a settings panel.

### Composer accessories

```tsx
function makeDraftLength(ctx: PluginContext<typeof settings>) {
  const subscribe = (fn: () => void) => ctx.stores.local.subscribe(fn);
  return function DraftLength({ conversationId }: { conversationId: ConversationId }) {
    const draft = useSyncExternalStore(
      subscribe,
      () => ctx.stores.local.getState().conversations[conversationId]?.draft ?? '',
    );
    return draft.length > 1000 ? <span>{draft.length}</span> : null;
  };
}

ctx.composer.addAccessory('draft-length', makeDraftLength(ctx));
```

Rendered inside the composer field next to the emoji button (slot
`composer.accessories`), with props `{ conversationId }`. Vim Mode's mode pill
is one.

### Toasts and logging

```ts
ctx.toast('Saved', 'success'); // kinds: 'info' (default) | 'success' | 'error'
ctx.log.warn('something odd', { id: 1 }); // console, prefixed [plugin:<id>]
```

Toasts are attributed to your plugin. Keep them for things the user asked for
or must know; Keyword Alerts makes its toast a setting.

### Stores and the backend facade

```ts
const self = ctx.stores.session.getState().self;
const open = uiSelectors.selectedConversation(ctx.stores.ui.getState());
if (open && ctx.backend.status() === 'online') void ctx.backend.sendText(open, 'hi **there**');
ctx.backend.onMessage((m) => {
  ctx.log.info('new message in', m.conversationId);
});
```

- `ctx.stores` gives `getState()` and `subscribe(listener)` for every store
  (`session`, `contacts`, `conversations`, `local`, `messages`, `typing`,
  `spaces`, `ui`, `settings`). The type is read-only on purpose: change state
  through the ctx APIs or by running commands. Selectors exported from
  `@/core/stores` (`uiSelectors`, `spacesSelectors`, …) work on these states.
- `ctx.backend` is a facade, not the transport: `kind` (`'mock' |
'signal-cli'`), `status()`, `sendText(conversationId, text)` (goes through
  the normal send pipeline, transforms included, Markdown per the user's
  setting) and `onMessage(fn)`, called once per **new** incoming or synced
  message after it has been stored (re-deliveries don't fire it).

## Error isolation

A plugin bug stays inside the plugin:

| Where it fails                            | What happens                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `start` throws or rejects                 | Everything it registered so far is disposed, the plugin is marked **failed**, other plugins carry on.         |
| A component throws while rendering        | Its `PluginBoundary` shows one small "Name failed" chip with a Retry button per plugin (not one per message). |
| A send transform throws / returns junk    | That transform is skipped and reported; the message is still sent.                                            |
| A typing guard throws                     | Treated as "allow".                                                                                           |
| A booster throws                          | Skipped; the next booster is asked.                                                                           |
| A command's `run` throws                  | Reported; `execute` resolves `false`.                                                                         |
| A key layer's `onKey` throws              | That layer is skipped for this key.                                                                           |
| `onClick` / `onSelect` / `visible` throws | Caught; a throwing `visible` hides the entry.                                                                 |
| `stop` throws                             | Reported; automatic disposal still runs.                                                                      |

Errors are logged to the console with the plugin id. A **failed** plugin's
card shows the error and a **Retry** button (`PluginRuntime.retry(id)`); a
render error's chip has its own Retry, and the boundary also resets by itself
when the plugin supplies a new component (e.g. after being re-enabled).
Duplicate ids are errors too: two plugins with one id throw
`DuplicatePluginError` at construction, and a duplicate command id or slash
name makes the second plugin's `start` fail.

## Registering a plugin

- **Headless plugins** (no React) live in `src/core/plugins/builtin/` and are
  added to `BUILTIN_PLUGINS` in `src/core/plugins/builtin/index.ts`. Core is
  React-free (lint enforces it), so a headless plugin can take its UI half as
  a parameter, like `createKeywordAlertsPlugin(ui)`.
- **Plugins with UI** live in `src/ui/plugins/` and are added to `UI_PLUGINS`
  in `src/ui/plugins/index.ts`. `withUiPlugins(BUILTIN_PLUGINS)` merges both
  lists (and gives Keyword Alerts its highlight UI); `createShrike` passes the
  result to the `PluginRuntime`.
- `src/ui/plugins/plugins.test.ts` asserts the full list of built-in ids, so
  update it when you add one, and add tests for your plugin next to it. The
  pattern in `src/core/plugins/plugins.test.ts` (a `PluginHost` with fakes, a
  `Registries`, a `PluginRuntime`) runs plugins headless.

## Worked example: Caps Guard

A complete plugin: settings, a send transform, a slash command, a decoration
with injected CSS, a hover action mirrored in the message menu, a header
button, a command, an `onMessage` listener and cleanup. It was compiled with
`tsc` against the real types and run through `PluginRuntime` in a test; it is
not shipped. To try it, save it as `src/ui/plugins/CapsGuard.tsx` and add
`capsGuardPlugin` to `UI_PLUGINS`.

```tsx
import { CaseLower, Megaphone } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { Message } from '@/core/domain';
import { definePlugin, defineSettings, type PluginContext } from '@/core/plugins';

const settings = defineSettings({
  action: {
    type: 'select',
    label: 'When you shout',
    description: 'What to do with an all-caps message you are about to send.',
    default: 'lower',
    options: [
      { value: 'lower', label: 'Lower-case it' },
      { value: 'keep', label: 'Send as typed' },
    ],
  },
  minLetters: {
    type: 'number',
    label: 'Minimum letters',
    description: 'Shorter messages ("OK", "LOL") never count as shouting.',
    default: 6,
    min: 2,
    max: 40,
    step: 1,
  },
  badge: {
    type: 'boolean',
    label: 'Badge shouted messages',
    default: true,
  },
});

type Ctx = PluginContext<typeof settings>;

/** True when `text` has at least `min` letters and none of them is lower-case. */
export function isShouting(text: string, min: number): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  return (
    letters.length >= min && letters.every((l) => l === l.toUpperCase() && l !== l.toLowerCase())
  );
}

const shouted = (ctx: Ctx, m: Message) =>
  m.kind === 'normal' && !m.deleted && isShouting(m.body, ctx.settings.get('minLetters'));

/** Stable hooks only: the chip is ours, the message row is `[data-shrike='message']`. */
const CSS = `
[data-caps-guard] {
  font-size: var(--shrike-font-size-xs);
  color: var(--shrike-warning);
  border: 1px solid currentColor;
  border-radius: var(--shrike-radius-full);
  padding: 0 var(--shrike-space-1);
}`;

function makeBadge(ctx: Ctx) {
  const subscribe = (fn: () => void) => ctx.stores.settings.subscribe(fn);
  return function ShoutBadge({ message }: { message: Message }) {
    // Re-render when this plugin's settings change (they live in the settings store).
    useSyncExternalStore(subscribe, () => ctx.stores.settings.getState().plugins[ctx.pluginId]);
    if (!ctx.settings.get('badge') || !shouted(ctx, message)) return null;
    return <span data-caps-guard="">shouting</span>;
  };
}

export const capsGuardPlugin = definePlugin({
  id: 'caps-guard',
  name: 'Caps Guard',
  description: 'Lower-cases all-caps messages before they go out and badges shouting.',
  authors: ['you'],
  tags: ['messages', 'fun'],
  settings,
  start(ctx) {
    // 1. Outgoing pipeline: return a new draft (same conversation), never mutate.
    ctx.send.addTransform((draft) =>
      ctx.settings.get('action') === 'lower' &&
      isShouting(draft.text, ctx.settings.get('minLetters'))
        ? { ...draft, text: draft.text.toLowerCase() }
        : draft,
    );

    // 2. A slash command: "/whisper HELLO" sends "hello".
    ctx.slash.register({
      name: 'whisper',
      description: 'Sends your message in lower case.',
      usage: '<message>',
      execute: (args) =>
        args
          ? { type: 'send', text: args.toLowerCase() }
          : { type: 'error', message: 'Usage: /whisper <message>' },
    });

    // 3. UI: a decoration next to the author name, plus its CSS.
    ctx.messages.addDecoration('shout-badge', makeBadge(ctx));
    ctx.styles.inject(CSS, 'badge');

    // 4. A hover-bar action and the same thing in the message menu.
    const copyLower = (m: Message) => {
      navigator.clipboard.writeText(m.body.toLowerCase()).then(
        () => {
          ctx.toast('Copied in lower case', 'success');
        },
        () => {
          ctx.toast('Couldn’t reach the clipboard', 'error');
        },
      );
    };
    ctx.messages.addHoverAction({
      id: 'copy-lower',
      label: 'Copy in lower case',
      icon: CaseLower,
      visible: (m) => shouted(ctx, m),
      onClick: copyLower,
    });
    ctx.menus.add('message', {
      id: 'copy-lower',
      label: 'Copy in lower case',
      icon: CaseLower,
      visible: (m) => shouted(ctx, m),
      onSelect: copyLower,
    });

    // 5. A chat-header button: how much shouting is loaded here?
    ctx.headerBar.addButton({
      id: 'shout-count',
      label: 'Count shouting',
      icon: Megaphone,
      onClick: (conversation) => {
        const window = ctx.stores.messages.getState().windows[conversation.id];
        const count = Object.values(window?.byId ?? {}).filter((m) => shouted(ctx, m)).length;
        ctx.toast(`${count} shouted message${count === 1 ? '' : 's'} loaded`, 'info');
      },
    });

    // 6. A command: in the palette (">caps"), bindable in Settings → Keybinds.
    ctx.commands.register({
      id: 'caps-guard.toggle',
      title: 'Caps Guard: toggle lower-casing',
      category: 'Plugins',
      run: () => {
        const next = ctx.settings.get('action') === 'lower' ? 'keep' : 'lower';
        ctx.settings.set('action', next);
        ctx.toast(next === 'lower' ? 'Shouting will be lower-cased' : 'Shouting allowed', 'info');
      },
    });

    // 7. React to incoming messages (after they are stored).
    let heard = 0;
    ctx.backend.onMessage((m) => {
      if (shouted(ctx, m)) heard++;
    });
    ctx.onDispose(() => {
      ctx.log.info(`heard ${heard} shouted messages this session`);
    });
  },
});
```

The test that verified it checked that every registration appears in
`Registries` while running and is gone after `setEnabled('caps-guard',
false)`, that `"STOP THE BUILD"` is sent as `"stop the build"` while `"OK"` is
left alone, and that the command flips the stored setting.

## Conventions

- **Ids.** Plugin ids are kebab-case and never change (they key stored
  settings). Prefix command ids with the plugin id (`caps-guard.toggle`) and
  give commands a title that starts with the plugin name.
- **No monkey-patching.** Don't reach into the DOM to change core UI or patch
  modules. If you need an extension point that doesn't exist, add it to
  `Registries` and `PluginContext` (with a test) rather than working around it.
- **Read settings at use time** (or subscribe); don't capture them once in
  `start`, or changes won't apply until a restart.
- **Return new objects** from transforms; never mutate the draft or messages.
- **Styling:** tokens (`var(--shrike-…)`) and stable hooks (`data-shrike`,
  `data-slot`, your own `data-*` attributes) only. No raw colours where a token
  exists, no hashed class names, no remote resources (the production CSP blocks
  them anyway).
- **Accessibility:** icon-only buttons get a `label`; anything in the hover bar
  should also be in a menu; key layers stay out of the way when
  `keyCtx.overlay` is true.
- **Privacy:** plugins run with the app's privileges. Don't send data anywhere
  except through `ctx.backend`; Shrike makes no third-party requests and the
  CSP's `connect-src 'self'` enforces it in production builds.
- **Keep core React-free:** a headless plugin in `core/` must not import React;
  put the UI half in `ui/plugins` and pass it in.
- **Tests:** colocate them; start the plugin through a `PluginRuntime` and
  assert on `Registries`, as `src/core/plugins/plugins.test.ts` does.
