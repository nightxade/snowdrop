import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, charCount, wordCount } from '@/core/plugins';
import { noteBadgeText, withUiPlugins } from './index';

describe('UI built-in plugins', () => {
  it('merges with the headless built-ins, giving Keyword Alerts its UI', () => {
    const all = withUiPlugins(BUILTIN_PLUGINS);
    const ids = all.map((p) => p.id);
    expect(ids).toEqual([
      'clear-urls',
      'slash-basics',
      'keyword-alerts',
      'relative-timestamps',
      'message-tools',
      'note-badge',
      'vim-mode',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.every((p) => !p.preview)).toBe(true);
  });

  it('badge shows the first non-empty line, cut by grapheme', () => {
    expect(noteBadgeText('\n  she/her \nmet at the crag', 20)).toBe('she/her');
    expect(noteBadgeText('climbing partner since 2019', 10)).toBe('climbing …');
    expect(noteBadgeText('👩‍👩‍👧 family group admin', 3)).toBe('👩‍👩‍👧 …');
  });

  it('counts words and characters like people do', () => {
    expect(wordCount('Rope’s in the car — leaving at 6!')).toBe(7);
    expect(wordCount('￼ can you check?')).toBe(4);
    expect(wordCount('   ')).toBe(0);
    expect(charCount('👩‍👩‍👧 ok')).toBe(4);
  });
});
