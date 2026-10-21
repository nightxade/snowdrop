import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('index.html', () => {
  it('turns DNS prefetching off, so visible link hosts are never resolved ahead of a click', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('<meta http-equiv="x-dns-prefetch-control" content="off" />');
  });
});
