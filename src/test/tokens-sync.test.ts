import { describe, expect, it } from 'vitest';
import { TOKEN_NAMES } from '@/core/themes';
import tokensCss from '@/ui/styles/tokens.css?raw';

describe('design tokens', () => {
  it('tokens.css and core/themes/tokens.ts declare the same names', () => {
    const declared = new Set(
      [...tokensCss.matchAll(/--hearth-([a-z0-9-]+)\s*:/gu)].map((m) => m[1] as string),
    );
    expect([...declared].sort()).toEqual([...TOKEN_NAMES].sort());
  });
});
