/**
 * H2: Snowdrop does not restore its saved window state. The window-state plugin brought a tiling
 * compositor's "maximized" flag back and covered the other tiles; it must not come back by way of
 * any of the places a Tauri plugin is wired in.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');

describe('window state (H2)', () => {
  it('has no window-state plugin in the Rust crate, the npm packages or the capabilities', () => {
    expect(read('src-tauri', 'Cargo.toml')).not.toMatch(/window-state/u);
    expect(read('package.json')).not.toMatch(/window-state/u);
    for (const file of readdirSync(join(root, 'src-tauri', 'capabilities')))
      expect(read('src-tauri', 'capabilities', file)).not.toMatch(/window-state/u);
    expect(read('src-tauri', 'tauri.conf.json')).not.toMatch(/window-state/u);
  });

  it('never registers the plugin in the app builder', () => {
    for (const file of readdirSync(join(root, 'src-tauri', 'src'), { recursive: true })) {
      const name = String(file);
      if (!name.endsWith('.rs')) continue;
      expect(read('src-tauri', 'src', name), name).not.toMatch(/tauri_plugin_window_state::/u);
    }
  });
});
