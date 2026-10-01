/**
 * Built-in themes as token overrides on top of tokens.css (which *is* Ember).
 * Raw colour values are allowed here and in tokens.css only (PLAN §7).
 */
import type { TokenOverrides } from './tokens';

export type ThemeKind = 'dark' | 'light';

export interface Theme {
  id: string;
  name: string;
  description: string;
  kind: ThemeKind;
  tokens: TokenOverrides;
  /** Extra CSS appended after the token block (for effects tokens can't express). */
  css?: string;
  /** Representative colours for theme cards: [background, surface, text, accent]. */
  preview: [string, string, string, string];
}

export const EMBER: Theme = {
  id: 'ember',
  name: 'Ember',
  description: 'Warm dark neutrals with an ember accent. The default.',
  kind: 'dark',
  tokens: {},
  preview: ['#101114', '#1b1d22', '#e9e7e4', '#ff7a59'],
};

export const MIDNIGHT: Theme = {
  id: 'midnight',
  name: 'Midnight',
  description: 'True black surfaces for OLED screens and late nights.',
  kind: 'dark',
  tokens: {
    'bg-rail': '#000000',
    'bg-sidebar': '#050506',
    'bg-chat': '#000000',
    'bg-elevated': '#0e0f11',
    'bg-floating': '#0a0a0b',
    'bg-input': '#0e0f11',
    'bg-hover': 'rgba(255, 255, 255, 0.05)',
    'bg-active': 'rgba(255, 255, 255, 0.09)',
    'bg-selected': 'rgba(255, 255, 255, 0.11)',
    border: 'rgba(255, 255, 255, 0.08)',
    'border-strong': 'rgba(255, 255, 255, 0.14)',
    'code-bg': '#0b0c0e',
    'spoiler-bg': '#2c2e33',
    'text-faint': '#7f7c7b',
  },
  preview: ['#000000', '#0e0f11', '#e9e7e4', '#ff7a59'],
};

export const LINEN: Theme = {
  id: 'linen',
  name: 'Linen',
  description: 'A warm paper-toned light theme.',
  kind: 'light',
  tokens: {
    'bg-rail': '#e4ded5',
    'bg-sidebar': '#eee9e2',
    'bg-chat': '#faf8f4',
    'bg-elevated': '#ffffff',
    'bg-floating': '#ffffff',
    'bg-input': '#efebe4',
    'bg-hover': 'rgba(40, 30, 20, 0.05)',
    'bg-active': 'rgba(40, 30, 20, 0.08)',
    'bg-selected': 'rgba(40, 30, 20, 0.1)',
    'bg-overlay': 'rgba(30, 24, 18, 0.45)',
    border: 'rgba(40, 30, 20, 0.1)',
    'border-strong': 'rgba(40, 30, 20, 0.18)',
    text: '#26221f',
    'text-strong': '#0d0b0a',
    'text-muted': '#5f5955',
    'text-faint': '#655f5a',
    'text-on-accent': '#ffffff',
    'text-link': '#b3421e',
    accent: '#bc4526',
    'accent-hover': '#a93d20',
    'accent-active': '#94341b',
    'accent-soft': 'rgba(188, 69, 38, 0.14)',
    danger: '#b3203f',
    'danger-strong': '#b3203f',
    'danger-soft': 'rgba(196, 47, 76, 0.12)',
    success: '#1c8456',
    warning: '#9a6200',
    info: '#1f6fb2',
    'mention-bg': 'rgba(188, 69, 38, 0.1)',
    'mention-bar': '#bc4526',
    'mention-pill-bg': 'rgba(188, 69, 38, 0.16)',
    'mention-pill-text': '#98391b',
    'code-bg': '#efeae2',
    'spoiler-bg': '#cfc7bd',
    'highlight-bg': 'rgba(245, 180, 74, 0.25)',
    'focus-ring': '#bc4526',
    'scrollbar-thumb': 'rgba(40, 30, 20, 0.22)',
    'shadow-menu': '0 8px 24px rgba(40, 30, 20, 0.14), 0 0 0 1px rgba(40, 30, 20, 0.08)',
    'shadow-popout': '0 12px 32px rgba(40, 30, 20, 0.16), 0 0 0 1px rgba(40, 30, 20, 0.08)',
    'shadow-modal': '0 24px 64px rgba(40, 30, 20, 0.22), 0 0 0 1px rgba(40, 30, 20, 0.08)',
  },
  preview: ['#e4ded5', '#faf8f4', '#26221f', '#bc4526'],
};

export const HIGH_CONTRAST: Theme = {
  id: 'high-contrast',
  name: 'High Contrast',
  description: 'Maximum legibility: black surfaces, bright text, strong outlines.',
  kind: 'dark',
  tokens: {
    'bg-rail': '#000000',
    'bg-sidebar': '#000000',
    'bg-chat': '#000000',
    'bg-elevated': '#111111',
    'bg-floating': '#000000',
    'bg-input': '#111111',
    'bg-hover': 'rgba(255, 255, 255, 0.12)',
    'bg-active': 'rgba(255, 255, 255, 0.2)',
    'bg-selected': 'rgba(255, 255, 255, 0.24)',
    border: 'rgba(255, 255, 255, 0.4)',
    'border-strong': 'rgba(255, 255, 255, 0.7)',
    text: '#ffffff',
    'text-strong': '#ffffff',
    'text-muted': '#d6d6d6',
    'text-faint': '#b5b5b5',
    'text-link': '#ffc2ad',
    accent: '#ff9270',
    'accent-hover': '#ffa98c',
    'accent-active': '#ff7a59',
    'accent-soft': 'rgba(255, 146, 112, 0.28)',
    danger: '#ff6b87',
    'danger-strong': '#ff6b87',
    'text-on-danger': '#000000',
    success: '#4df0a8',
    warning: '#ffcc66',
    'mention-bg': 'rgba(255, 146, 112, 0.2)',
    'mention-bar': '#ff9270',
    'mention-pill-text': '#ffffff',
    'code-bg': '#1a1a1a',
    'spoiler-bg': '#5a5a5a',
    'focus-ring': '#ffffff',
    'scrollbar-thumb': 'rgba(255, 255, 255, 0.5)',
  },
  css: ':root { --hearth-shadow-menu: 0 0 0 2px #ffffff; --hearth-shadow-popout: 0 0 0 2px #ffffff; --hearth-shadow-modal: 0 0 0 2px #ffffff; }',
  preview: ['#000000', '#111111', '#ffffff', '#ff9270'],
};

export const BUILTIN_THEMES: readonly Theme[] = [EMBER, MIDNIGHT, LINEN, HIGH_CONTRAST];

export const DEFAULT_THEME_ID = EMBER.id;

export function findTheme(id: string, extra: readonly Theme[] = []): Theme {
  return [...BUILTIN_THEMES, ...extra].find((t) => t.id === id) ?? EMBER;
}
