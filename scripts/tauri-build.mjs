#!/usr/bin/env node
/**
 * `tauri build` with the AppImage's GL/EGL loader libraries excluded.
 *
 * linuxdeploy otherwise bundles e.g. libGLESv2.so.2 (pulled in by the
 * GStreamer plugins). Those loaders must come from the host (libglvnd) to
 * match its GPU drivers: with the bundled copy, WebKitGTK fell onto a slow
 * path and a single frame took ~5 s to paint on an Intel Meteor Lake laptop
 * (Settings and popups froze); without it, ~30 ms.
 */
import { spawnSync } from 'node:child_process';

const EXCLUDED = [
  'libGLESv2.so*',
  'libGL.so*',
  'libEGL.so*',
  'libGLX.so*',
  'libGLdispatch.so*',
  'libOpenGL.so*',
];

const result = spawnSync('npx', ['tauri', 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, LINUXDEPLOY_EXCLUDED_LIBRARIES: EXCLUDED.join(';') },
});
process.exit(result.status ?? 1);
