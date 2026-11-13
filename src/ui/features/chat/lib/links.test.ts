import { describe, expect, it } from 'vitest';
import { explicitUrls, findLinks } from './links';
import { firstUrlInText, previewUrlInText } from './linkPreviews';

const texts = (s: string) => findLinks(s).map((l) => l.text);

describe('explicitUrls', () => {
  it('keeps a closing bracket that matches an opener in the address', () => {
    expect(explicitUrls('https://en.wikipedia.org/wiki/Foo_(bar)')[0]?.href).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
    expect(explicitUrls('https://x.org/a[1]')[0]?.href).toBe('https://x.org/a[1]');
  });

  it('leaves a bracket that closes surrounding prose outside', () => {
    expect(explicitUrls('(see https://x.org)')[0]?.href).toBe('https://x.org');
    expect(explicitUrls('[https://x.org/a]')[0]?.href).toBe('https://x.org/a');
    expect(explicitUrls('(https://x.org/Foo_(bar)).')[0]?.href).toBe('https://x.org/Foo_(bar)');
  });

  it('drops trailing punctuation and ignores bare domains', () => {
    expect(explicitUrls('go to https://x.org/a?b=1.')[0]?.href).toBe('https://x.org/a?b=1');
    expect(explicitUrls('example.com and www.example.com')).toEqual([]);
  });
});

describe('findLinks', () => {
  it('links bare domains with an https href and the text as typed', () => {
    const [a] = findLinks('visit example.com now');
    expect(a).toMatchObject({ text: 'example.com', href: 'https://example.com' });
    expect(findLinks('www.example.com/path')[0]?.href).toBe('https://www.example.com/path');
    expect(texts('sub.example.co.uk, ok')).toEqual(['sub.example.co.uk']);
  });

  it('keeps explicit and bare links together, in order', () => {
    expect(texts('a.com then https://b.org/x then c.net')).toEqual([
      'a.com',
      'https://b.org/x',
      'c.net',
    ]);
  });

  it('does not link emails, IPs, file names or non-http schemes', () => {
    expect(texts('mail me@example.com')).toEqual([]);
    expect(texts('1.2.3.4 and notes.txt')).toEqual([]);
    expect(texts('mailto:a@b.com ftp://x.com/f')).toEqual([]);
  });
});

describe('link previews', () => {
  it('only consider explicit http(s) urls', () => {
    expect(firstUrlInText('see example.com')).toBeUndefined();
    expect(firstUrlInText('see (https://x.org/Foo_(bar))')).toBe('https://x.org/Foo_(bar)');
  });

  it('require the preview url to still appear in the text', () => {
    const preview = { url: 'https://x.org/Foo_(bar)' } as Parameters<typeof previewUrlInText>[0];
    expect(previewUrlInText(preview, 'read https://x.org/Foo_(bar)')).toBe(true);
    expect(previewUrlInText(preview, 'read x.org/Foo_(bar)')).toBe(false);
  });
});
