# Theming

Every colour, size, radius, shadow and duration in Shrike is a CSS custom
property named `--shrike-<token>`. A theme is a set of token overrides (plus
optional CSS); Custom CSS is your own stylesheet on top. Both can be shared as
files, and both are filtered so they can never make the browser fetch anything.

- Change themes, accent, density and text size in **Settings → Appearance**.
- Import and export themes in **Settings → Themes**.
- Write your own CSS in **Settings → Custom CSS**.

## How styles are applied

`src/ui/styles/tokens.css` defines every token on `:root`; those values _are_
the default theme, Dusk. The theme engine (`applyAppearance` in
`src/core/themes/engine.ts`) then keeps three `<style>` tags at the end of
`<head>`, in this cascade order:

| Tag                  | Contents                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `#shrike-theme`      | `:root { … }` with the active theme's tokens, accent overrides and derived tokens, then the theme's own `css`. |
| `#shrike-plugins`    | CSS injected by enabled plugins (`ctx.styles.inject`).                                                         |
| `#shrike-custom-css` | Your Custom CSS, sanitised.                                                                                    |

So Custom CSS beats plugins, which beat the theme. Tokens a theme leaves out
keep their `tokens.css` (Dusk) values, also in light themes.

The engine also sets attributes on `<html>` that CSS can use:
`data-theme` (theme id), `data-theme-kind` (`dark` | `light`), `data-density`
(`comfortable` | `compact`), `data-reduced-motion` (`on` | `off`, absent =
follow the OS), `data-saturation-adjusted`, `data-focus="strong"` and
`data-targets="large"` (Accessibility settings).

## Token reference

<!-- Generated from TOKEN_NAMES (src/core/themes/tokens.ts), the values in
     src/ui/styles/tokens.css, tokenKind() and the built-in themes. -->

101 tokens. **Kind** decides which values an imported theme may use for the
token (see [validation](#validation-rules)). **Overridden by** lists the
built-in themes that change the token (M = Midnight, L = Linen, HC = High
Contrast); _accent override_ marks tokens recomputed when you pick an accent
colour, and _engine_ marks tokens the engine always sets (from settings, or
derived), so a theme's value for them is ignored.

#### Surfaces

| Token           | Kind  | Dusk (base) value           | Overridden by |
| --------------- | ----- | --------------------------- | ------------- |
| `bg-rail`       | color | `#101114`                   | M, L, HC      |
| `bg-sidebar`    | color | `#15171b`                   | M, L, HC      |
| `bg-chat`       | color | `#1b1d22`                   | M, L, HC      |
| `bg-elevated`   | color | `#22252b`                   | M, L, HC      |
| `bg-floating`   | color | `#0c0d10`                   | M, L, HC      |
| `bg-input`      | color | `#22252b`                   | M, L, HC      |
| `bg-hover`      | color | `rgba(255, 255, 255, 0.04)` | M, L, HC      |
| `bg-active`     | color | `rgba(255, 255, 255, 0.08)` | M, L, HC      |
| `bg-selected`   | color | `rgba(255, 255, 255, 0.1)`  | M, L, HC      |
| `bg-overlay`    | color | `rgba(6, 7, 9, 0.72)`       | L             |
| `border`        | color | `rgba(255, 255, 255, 0.06)` | M, L, HC      |
| `border-strong` | color | `rgba(255, 255, 255, 0.12)` | M, L, HC      |

#### Text

| Token            | Kind  | Dusk (base) value | Overridden by        |
| ---------------- | ----- | ----------------- | -------------------- |
| `text`           | color | `#e6e8eb`         | L, HC                |
| `text-strong`    | color | `#ffffff`         | L, HC                |
| `text-muted`     | color | `#a2a5aa`         | L, HC                |
| `text-faint`     | color | `#8d9096`         | M, L, HC             |
| `text-on-accent` | color | `#1a0f0b`         | L, _accent override_ |
| `text-on-avatar` | color | `#ffffff`         | —                    |
| `text-on-danger` | color | `#ffffff`         | HC                   |
| `text-link`      | color | `#f69369`         | L, HC                |

#### Accent

| Token           | Kind  | Dusk (base) value          | Overridden by            |
| --------------- | ----- | -------------------------- | ------------------------ |
| `accent`        | color | `#d4744a`                  | L, HC, _accent override_ |
| `accent-hover`  | color | `#e58359`                  | L, HC, _accent override_ |
| `accent-active` | color | `#c06238`                  | L, HC, _accent override_ |
| `accent-soft`   | color | `rgba(212, 116, 74, 0.16)` | L, HC, _accent override_ |
| `accent-text`   | color | `#d4744a`                  | _engine_                 |

#### Status

| Token           | Kind  | Dusk (base) value          | Overridden by |
| --------------- | ----- | -------------------------- | ------------- |
| `danger`        | color | `#f0506e`                  | L, HC         |
| `danger-strong` | color | `#c93553`                  | L, HC         |
| `danger-soft`   | color | `rgba(240, 80, 110, 0.14)` | L             |
| `success`       | color | `#3ccf91`                  | L, HC         |
| `warning`       | color | `#f5b44a`                  | L, HC         |
| `info`          | color | `#6ab7ff`                  | L             |

#### Messages

| Token               | Kind  | Dusk (base) value           | Overridden by            |
| ------------------- | ----- | --------------------------- | ------------------------ |
| `mention-bg`        | color | `rgba(212, 116, 74, 0.1)`   | L, HC, _accent override_ |
| `mention-bar`       | color | `#d4744a`                   | L, HC, _accent override_ |
| `mention-pill-bg`   | color | `rgba(212, 116, 74, 0.22)`  | L, _accent override_     |
| `mention-pill-text` | color | `#f9d4c3`                   | L, HC                    |
| `code-bg`           | color | `#121317`                   | M, L, HC                 |
| `spoiler-bg`        | color | `#3a3d45`                   | M, L, HC                 |
| `highlight-bg`      | color | `rgba(245, 180, 74, 0.14)`  | L                        |
| `focus-ring`        | color | `#d4744a`                   | L, HC, _accent override_ |
| `scrollbar-thumb`   | color | `rgba(255, 255, 255, 0.14)` | L, HC                    |

#### Avatar hues

| Token       | Kind  | Dusk (base) value | Overridden by |
| ----------- | ----- | ----------------- | ------------- |
| `avatar-1`  | color | `#bd523c`         | —             |
| `avatar-2`  | color | `#a95b1a`         | —             |
| `avatar-3`  | color | `#806d12`         | —             |
| `avatar-4`  | color | `#4a8028`         | —             |
| `avatar-5`  | color | `#218055`         | —             |
| `avatar-6`  | color | `#1c7b7a`         | —             |
| `avatar-7`  | color | `#2878a8`         | —             |
| `avatar-8`  | color | `#4a68c4`         | —             |
| `avatar-9`  | color | `#7059c7`         | —             |
| `avatar-10` | color | `#9150b3`         | —             |
| `avatar-11` | color | `#b24b8a`         | —             |
| `avatar-12` | color | `#c14b62`         | —             |

#### Spacing

| Token     | Kind   | Dusk (base) value | Overridden by |
| --------- | ------ | ----------------- | ------------- |
| `space-0` | length | `0`               | —             |
| `space-1` | length | `2px`             | —             |
| `space-2` | length | `4px`             | —             |
| `space-3` | length | `8px`             | —             |
| `space-4` | length | `12px`            | —             |
| `space-5` | length | `16px`            | —             |
| `space-6` | length | `20px`            | —             |
| `space-7` | length | `24px`            | —             |
| `space-8` | length | `32px`            | —             |
| `space-9` | length | `48px`            | —             |

#### Radii

| Token         | Kind   | Dusk (base) value | Overridden by |
| ------------- | ------ | ----------------- | ------------- |
| `radius-tile` | length | `14px`            | —             |
| `radius-xs`   | length | `4px`             | —             |
| `radius-sm`   | length | `8px`             | —             |
| `radius-md`   | length | `12px`            | —             |
| `radius-lg`   | length | `16px`            | —             |
| `radius-full` | length | `9999px`          | —             |

#### Layout

| Token           | Kind   | Dusk (base) value | Overridden by |
| --------------- | ------ | ----------------- | ------------- |
| `rail-width`    | length | `72px`            | —             |
| `sidebar-width` | length | `248px`           | —             |
| `members-width` | length | `248px`           | —             |
| `header-height` | length | `48px`            | —             |
| `tile-size`     | length | `48px`            | —             |

#### Typography

| Token                  | Kind        | Dusk (base) value                                                      | Overridden by |
| ---------------------- | ----------- | ---------------------------------------------------------------------- | ------------- |
| `font-sans`            | font-family | `'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif`   | —             |
| `font-mono`            | font-family | `'JetBrains Mono Variable', ui-monospace, 'SFMono-Regular', monospace` | —             |
| `font-scale`           | number      | `1`                                                                    | _engine_      |
| `font-size-xs`         | length      | `calc(11px * var(--shrike-font-scale))`                                | —             |
| `font-size-sm`         | length      | `calc(12px * var(--shrike-font-scale))`                                | —             |
| `font-size-ui`         | length      | `calc(14px * var(--shrike-font-scale))`                                | —             |
| `font-size-message`    | length      | `calc(15px * var(--shrike-font-scale))`                                | —             |
| `font-size-header`     | length      | `calc(16px * var(--shrike-font-scale))`                                | —             |
| `font-size-title`      | length      | `calc(20px * var(--shrike-font-scale))`                                | —             |
| `font-size-display`    | length      | `calc(28px * var(--shrike-font-scale))`                                | —             |
| `line-height-message`  | number      | `1.375`                                                                | —             |
| `line-height-ui`       | number      | `1.3`                                                                  | —             |
| `font-weight-regular`  | number      | `400`                                                                  | —             |
| `font-weight-medium`   | number      | `500`                                                                  | —             |
| `font-weight-semibold` | number      | `600`                                                                  | —             |
| `font-weight-bold`     | number      | `700`                                                                  | —             |
| `tracking-label`       | length      | `0.02em`                                                               | —             |

#### Shadows

| Token           | Kind   | Dusk (base) value                                                     | Overridden by |
| --------------- | ------ | --------------------------------------------------------------------- | ------------- |
| `shadow-menu`   | shadow | `0 8px 24px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05)` | L             |
| `shadow-popout` | shadow | `0 12px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05)` | L             |
| `shadow-modal`  | shadow | `0 24px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06)` | L             |

#### Motion

| Token           | Kind     | Dusk (base) value                | Overridden by |
| --------------- | -------- | -------------------------------- | ------------- |
| `ease`          | easing   | `cubic-bezier(0.2, 0.8, 0.2, 1)` | —             |
| `duration-fast` | duration | `120ms`                          | —             |
| `duration-base` | duration | `160ms`                          | —             |
| `duration-slow` | duration | `200ms`                          | —             |

#### Misc

| Token        | Kind   | Dusk (base) value | Overridden by |
| ------------ | ------ | ----------------- | ------------- |
| `qr-ink`     | color  | `#000000`         | —             |
| `qr-paper`   | color  | `#ffffff`         | —             |
| `saturation` | number | `1`               | _engine_      |
| `zoom`       | number | `1`               | _engine_      |

## Built-in themes

Defined in `src/core/themes/builtin.ts` (`BUILTIN_THEMES`). All text tokens
reach 4.5:1 on every surface in every built-in theme, and white initials reach
4.5:1 on every avatar hue; `src/test/contrast.test.ts` and
`src/core/themes/themes.test.ts` enforce it.

| Id              | Name          | Kind  | Description                                                                                        | Accent    |
| --------------- | ------------- | ----- | -------------------------------------------------------------------------------------------------- | --------- |
| `dusk`          | Dusk          | dark  | Graphite neutrals with a rufous accent. The default (`tokens.css`).                                | `#d4744a` |
| `midnight`      | Midnight      | dark  | True black surfaces for OLED screens and late nights.                                              | `#d4744a` |
| `linen`         | Linen         | light | A warm paper-toned light theme.                                                                    | `#a84f2c` |
| `high-contrast` | High Contrast | dark  | Black surfaces, bright text, strong outlines (its `css` replaces shadows with 2px white outlines). | `#ef8d62` |

Every built-in theme is also a command: type `>theme` in the quick switcher.

## Accent colour

**Settings → Appearance → Accent** offers presets (`ACCENT_PRESETS`: Rufous,
Amber, Moss, Teal, Sky, Indigo, Violet, Rose, Slate) or any hex colour. An
accent override replaces the theme's accent family with tokens derived from
that one colour (`deriveAccentTokens`):

| Token                                 | Derived as                                                       |
| ------------------------------------- | ---------------------------------------------------------------- |
| `accent`, `mention-bar`, `focus-ring` | the colour itself                                                |
| `accent-hover`                        | OKLCH lightness +0.05 on dark themes, −0.05 on light             |
| `accent-active`                       | the opposite direction, 0.06                                     |
| `accent-soft`                         | 16 % alpha                                                       |
| `mention-bg`, `mention-pill-bg`       | 10 % and 22 % alpha                                              |
| `text-on-accent`                      | `#1a0f0b` or `#ffffff`, whichever contrasts more with the accent |

**`accent-text`** is the accent used _as text_ (links in the UI, selected
labels). It is always computed by the engine, with or without an override
(`deriveAccentText`): if the accent already reaches 4.5:1 on the theme's
`bg-chat` it is used as is; otherwise its OKLCH lightness is moved away from
the background (lighter on dark themes, darker on light ones) in 0.01 steps
until it does, falling back to white or black. Components use
`--shrike-accent-text`, never `--shrike-accent`, for accent-coloured text. If
either colour isn't hex (e.g. a custom theme using `rgb()`), the accent is used
unchanged, so give custom themes hex `accent` and `bg-chat` values.

The Appearance page warns when a custom accent gives text-on-accent below
4.5:1, or when the accent itself is below 3:1 against `bg-chat` (buttons, rings
and the mention bar are non-text UI, which needs 3:1).

## Theme files

### Format

```json
{
  "id": "seaglass",
  "name": "Seaglass",
  "kind": "dark",
  "tokens": {
    "bg-rail": "#0b1416",
    "accent": "#3fb8a6",
    "--shrike-radius-md": "10px"
  },
  "css": "[data-shrike='message'][data-mention] { box-shadow: inset 2px 0 0 var(--shrike-accent); }"
}
```

| Field    | Required | Notes                                                                                                                                               |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`   | yes      | 1–40 characters.                                                                                                                                    |
| `id`     | no       | Lower-case letters, digits and dashes, starting with a letter or digit, ≤ 48 characters. Defaults to a slug of the name. Built-in ids are reserved. |
| `kind`   | no       | `"dark"` (default) or `"light"`; sets `color-scheme` and the direction of accent shading.                                                           |
| `tokens` | yes      | Object of token name → CSS value. Names may be bare (`accent`) or prefixed (`--shrike-accent`). May be empty.                                       |
| `css`    | no       | Extra CSS appended after the token block, ≤ 100 kB. Sanitised like Custom CSS.                                                                      |

Export writes the same shape (`exportTheme`) to `<id>.shrike-theme.json`.
Exporting a built-in produces `<id>-copy` / "<Name> copy", since built-in ids
can't be imported. Dusk's export has no tokens: its values live in
`tokens.css`, which every theme inherits.

### Validation rules

Imported files are untrusted (`validateTheme` in `src/core/themes/custom.ts`).
A file is rejected, with every problem listed, when:

- the file is larger than 200 kB, isn't JSON, or isn't an object;
- `name` is missing or longer than 40 characters; `id` doesn't match
  `^[a-z0-9][a-z0-9-]{0,47}$` or is a built-in id; `kind` is something other
  than `dark` / `light`;
- `tokens` isn't an object, contains an unknown token name, or a value that
  isn't a string or isn't valid for the token's kind;
- `css` isn't a string or is over 100 kB.

A token value (`isValidTokenValue` in `src/core/themes/tokenValues.ts`) must:

- be non-empty and at most 200 characters;
- contain none of `\` (escapes), `;` `{` `}` `<` `>` (declaration
  break-outs), `@` (at-rules), comments, or the resource functions `url(`,
  `image-set(`, `image(`, `cross-fade(`, `element(`;
- parse as its kind: `color` as a colour, `length` as a width, `number` as an
  opacity, `font-family`, `shadow` as a box-shadow, `easing` as a timing
  function, `duration` as a transition duration. The browser's
  `CSS.supports()` decides; where it is missing, narrow regular expressions do.

Remote references in `css` don't reject the file: they are removed and the
import reports "Removed N remote references from the theme CSS (privacy)".

After import:

- Importing a theme whose id you already have asks before replacing it.
- A theme **with CSS** applies on probation: a "Keep this theme?" bar counts
  down 10 seconds and reverts automatically unless you press Keep, so CSS that
  hides the UI can't stick.
- Stored themes are validated again every time they load (`toTheme`):
  storage is untrusted too.
- Tokens a theme leaves out keep Dusk's values. A light theme should therefore
  set at least the surfaces, borders and text tokens.

### Example

This file passes the validator (checked with `parseThemeJson`, both with
`CSS.supports` and with the regex fallback), and its text tokens reach 4.5:1 on
its surfaces:

```json
{
  "id": "seaglass",
  "name": "Seaglass",
  "kind": "dark",
  "tokens": {
    "bg-rail": "#0b1416",
    "bg-sidebar": "#0f1b1e",
    "bg-chat": "#132226",
    "bg-elevated": "#1a2c31",
    "bg-floating": "#0a1214",
    "bg-input": "#1a2c31",
    "text": "#e2eeee",
    "text-muted": "#9fb5b6",
    "accent": "#3fb8a6",
    "accent-hover": "#52c9b7",
    "accent-active": "#2fa392",
    "text-on-accent": "#06201c",
    "--shrike-radius-md": "10px",
    "line-height-message": "1.4",
    "shadow-menu": "0 8px 24px rgba(0, 0, 0, 0.5)",
    "duration-base": "160ms"
  },
  "css": "[data-shrike='message'][data-mention] { box-shadow: inset 2px 0 0 var(--shrike-accent); }"
}
```

## Custom CSS

**Settings → Custom CSS** is a code editor (Tab indents two spaces,
Shift+Tab outdents, Esc releases Tab so it moves focus again). Changes apply
300 ms after you stop typing, in the last `<style>` tag (`#shrike-custom-css`),
after the theme and plugins. It is stored in `settings.customCss` and goes
through the same sanitiser as theme CSS.

```css
/* Roomier messages and a softer mention tint */
[data-shrike='message'] {
  padding-block: 4px;
}
:root {
  --shrike-mention-bg: rgba(212, 116, 74, 0.06);
}
```

### Stable hooks

CSS-module class names are hashed and change between builds. Target these
instead.

**Regions: `[data-shrike='…']`.** Every value used in the app:

| Hook                   | Element                                     |
| ---------------------- | ------------------------------------------- |
| `app`                  | The whole shell                             |
| `rail`                 | Spaces rail                                 |
| `drawer`               | Rail + sidebar slide-over on narrow screens |
| `sidebar`              | Conversation sidebar                        |
| `sidebar-header`       | Sidebar title bar                           |
| `conversation-list`    | Conversation list                           |
| `conversation-row`     | One conversation in the sidebar             |
| `section-header`       | Sidebar section / category header           |
| `user-panel`           | Your profile at the bottom of the sidebar   |
| `chat`                 | Chat column                                 |
| `chat-header`          | Chat title bar                              |
| `member-toggle`        | Member-list button in the chat header       |
| `connection-banner`    | Connection-problem banner above the chat    |
| `message-pane`         | Message area                                |
| `message-log`          | The message list                            |
| `conversation-intro`   | "Beginning of your conversation" block      |
| `history-skeleton`     | Loading placeholder rows                    |
| `message`              | One message row (see attributes below)      |
| `message-body`         | The text of a message                       |
| `hover-bar`            | Message hover actions                       |
| `message-action-sheet` | Long-press action sheet (touch)             |
| `system-message`       | Joined / renamed / timer lines              |
| `new-divider`          | The "New" line at the first unread message  |
| `new-messages-bar`     | "N new messages since …" bar                |
| `jump-to-present`      | Jump-to-present pill                        |
| `composer`             | Message composer                            |
| `composer-input`       | The composer's textarea                     |
| `attachment-tray`      | Attachments waiting to be sent              |
| `reply-bar`            | "Replying to …" bar                         |
| `autocomplete`         | @ / : / slash suggestions                   |
| `typing-line`          | "… is typing" strip                         |
| `drop-overlay`         | Drag-and-drop overlay                       |
| `search-panel`         | In-conversation search results              |
| `members`              | Member list                                 |
| `member-row`           | One member                                  |
| `settings`             | Settings screen                             |
| `plugin-card`          | A plugin in Settings → Plugins              |
| `welcome`              | Welcome / connection setup screens          |
| `link-device`          | Device-linking screen                       |
| `note-badge`           | Pronoun & Notes Badge plugin's badge        |
| `vim-mode`             | Vim Mode plugin's mode pill                 |

**Attributes on those elements:**

- `[data-shrike='message']` carries `data-compact`, `data-continuation` (a
  grouped follow-up row) and `data-mention` (mentions you).
- Message times are `<time data-variant='header' | 'gutter' | 'compact'>`.
- The Vim mode pill carries `data-vim-mode='normal' | 'insert' | 'visual' |
'visual-line'`.
- Sidebar rows carry `data-conversation-id`.
- Icon buttons carry `data-icon-button`.

**Plugin slots: `[data-slot='…']`.** `message.decorations`,
`message.accessories`, `composer.accessories`, `chat.header.buttons`.

**Document attributes** on `<html>`: see [How styles are applied](#how-styles-are-applied).

## Security policy

Any request your CSS makes to a third party is a beacon: it tells that server
when you use Shrike, and attribute selectors or `unicode-range` can even leak
what's on screen. Shrike therefore guarantees that user-supplied CSS and
themes can't fetch anything, with two independent layers.

### 1. The sanitiser

`sanitizeUserCss` (`src/core/themes/sanitize.ts`) runs on Custom CSS and theme
CSS on import, on load and again inside the engine, whatever the caller did.

- The CSS is split into statements at `{`, `;` and `}` outside strings,
  comments and parentheses (so the `;` in `url(data:…;base64,…)` doesn't split).
- Each statement is judged on a **normalised copy**: comments stripped, CSS
  escapes decoded (`@\69mport`, `https\3a //`), lower-cased. Tricks like
  `@import/**/url()` or escaped letters therefore can't hide a reference.
- A statement that mentions `@import`, `url(`, `image-set(`, `image(`,
  `cross-fade(` or `element(` is **removed** unless every target is inline
  (`data:` or `blob:`). If the reference is in a block's prelude, the whole
  block goes. Surviving statements are emitted exactly as written.

For example:

```css
@import url('https://example.com/a.css'); /* removed */
.a {
  color: red;
  background: url(https://example.com/p.png); /* this declaration removed */
}
.b {
  background: url(data:image/png;base64,AAAA); /* kept: inline */
}
@font-face {
  font-family: X;
  src: url(https://example.com/f.woff2); /* removed; the rest of the block stays */
}
```

The UI reports how many references were removed.

### 2. The Content-Security-Policy

Production builds carry a CSP meta tag (`devserver/csp.ts`, build only, since
the dev server needs inline scripts for hot reload):

```text
default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:;
font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self';
object-src 'none'; base-uri 'none'
```

Everything Shrike needs is same-origin, including signal-cli through the
`/signal-cli` proxy path, so even CSS that slipped past the sanitiser couldn't
load a remote font or image. `style-src 'unsafe-inline'` is required because
themes, plugin CSS and Custom CSS are inline `<style>` tags.

The rest of the app keeps the same rule: fonts (Inter, JetBrains Mono) are
bundled with `@fontsource-variable`, emoji data is served from our own origin
(`devserver/emojibase.ts`) instead of the picker's default CDN, and link
previews are off.

## Safe mode

If a theme or Custom CSS makes Shrike unusable, start in **safe mode**: open
the app with `?safe=1` in the URL, or hold **Shift** while it loads (within
the first 1.5 s; Shrike reloads into `?safe=1`). Imported themes and Custom
CSS are then not applied (a built-in theme is used instead) and a toast says
so; your settings are untouched, so you can switch theme or fix the CSS in
Settings, then reload normally.
