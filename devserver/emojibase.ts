/**
 * Serves the Emojibase dataset the emoji picker loads, from our own origin.
 *
 * frimousse fetches `${emojibaseUrl}/${locale}/{data,messages}.json` and
 * defaults to a public CDN, which would tell a third party whenever someone
 * opens the picker (PLAN §0: privacy by default, no CDNs). We ship the files
 * from the `emojibase-data` package instead: middleware in dev/preview, and
 * emitted assets in the build, at the same fixed paths.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Connect, Plugin } from 'vite';

/** Public path (under the app's base URL) the picker is pointed at. */
export const EMOJIBASE_PATH = 'emojibase';
const FILES = ['en/data.json', 'en/messages.json'] as const;

const require = createRequire(import.meta.url);

function read(file: string): Buffer {
  return readFileSync(require.resolve(`emojibase-data/${file}`));
}

export function emojibaseAssets(): Plugin {
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const path = (req.url ?? '').split('?')[0]?.replace(/^\//u, '');
    const file = FILES.find((f) => f === path);
    if (!file) {
      next();
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(read(file));
  };
  return {
    name: 'hearth:emojibase-assets',
    configureServer(server) {
      server.middlewares.use(`/${EMOJIBASE_PATH}`, serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(`/${EMOJIBASE_PATH}`, serve);
    },
    generateBundle() {
      for (const file of FILES) {
        this.emitFile({ type: 'asset', fileName: `${EMOJIBASE_PATH}/${file}`, source: read(file) });
      }
    },
  };
}
