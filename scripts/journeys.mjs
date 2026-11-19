// `npm run journeys`: builds the journey bundle (the production build plus a
// test driver, src/app/journeyDriver.ts), serves it with `vite preview`, runs
// journeys/run.py against it in real WebKitGTK, and stops everything it
// started by PID however the run ends: success, failure, an exception, or
// SIGINT / SIGTERM / SIGHUP at any point (build, preview start, run).
//
// Each child runs in its own process group (so the runner's WebKit processes
// are in the runner's group) and is stopped by signalling that group through
// the child's PID. Nothing is ever stopped by name.
//
//   npm run journeys                      the fast tier (the commit gate)
//   npm run journeys -- --full            every journey, the slow tier too
//   npm run journeys -- esc_from_composer one or more, by name
//   npm run journeys -- --no-build        reuse dist-journey/ as it is
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = 'dist-journey';
/** Present in the journey bundle, absent from every normal build. */
const DRIVER_MARKER = '__journey';
const VITE = path.join(root, 'node_modules/vite/bin/vite.js');

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
// Everything else goes to journeys/run.py: journey names, or `--fuzz --seed N --steps M`.
const forwarded = args.filter((a) => a !== '--no-build');

/** A failure of this script itself (not of a journey). */
class Abort extends Error {}

/** Every file under `dir`, recursively. */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

function bundleHas(dir, text) {
  return files(dir).some((f) => /\.(js|html)$/u.test(f) && readFileSync(f, 'utf8').includes(text));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The children this script started, still to be stopped. */
const started = new Set();

/** Starts a child in its own process group. Its PID is the group's id. */
function start(command, argv, options = {}) {
  const child = spawn(command, argv, { cwd: root, detached: true, ...options });
  started.add(child);
  child.once('exit', () => {
    child.done = true;
  });
  child.on('error', () => {
    child.done = true;
  });
  return child;
}

/** Signals a child's whole group (negative PID); a group that is already gone is fine. */
function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
}

/** Whether anything in the child's group is still alive (signal 0 tests only). */
function groupAlive(child) {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the child's group, then SIGKILL what is left of it after a grace period. */
async function stop(child) {
  signalGroup(child, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (groupAlive(child) && Date.now() < deadline) await sleep(50);
  if (groupAlive(child)) signalGroup(child, 'SIGKILL');
  started.delete(child);
}

async function stopAll() {
  await Promise.all([...started].map(stop));
}

function exited(child) {
  return new Promise((resolve) => {
    if (child.done) return resolve(child.exitCode ?? 1);
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.done) throw new Abort('vite preview exited before it was ready');
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Abort('vite preview did not start in time');
}

let interrupted = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = signal;
    // Stopping the children ends whatever the main flow is waiting on; it then cleans up and exits.
    void stopAll();
  });
}

async function main() {
  if (!noBuild) {
    const build = start(process.execPath, [VITE, 'build', '--mode', 'journey'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [build.stdout, build.stderr]) stream.on('data', (d) => (output += d));
    const code = await exited(build);
    started.delete(build);
    if (interrupted) return 130;
    if (code !== 0) {
      console.error(output);
      throw new Abort('the journey build failed');
    }
  }
  const out = path.join(root, OUT_DIR);
  if (!existsSync(out) || !statSync(out).isDirectory())
    throw new Abort(`${OUT_DIR}/ is missing: run without --no-build`);
  if (!bundleHas(out, DRIVER_MARKER))
    throw new Abort(`${OUT_DIR}/ has no journey driver: it was not built with --mode journey`);
  // The driver must never reach a real build: if a normal build is lying around, check it too.
  if (existsSync(path.join(root, 'dist')) && bundleHas(path.join(root, 'dist'), DRIVER_MARKER))
    throw new Abort('dist/ contains the journey driver: the normal build must not');

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const preview = start(
    process.execPath,
    [
      VITE,
      'preview',
      '--mode',
      'journey',
      '--outDir',
      OUT_DIR,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { stdio: 'ignore' },
  );
  await waitForServer(url, preview);
  if (interrupted) return 130;
  const run = start('python3', [path.join(root, 'journeys/run.py'), '--url', url, ...forwarded], {
    stdio: 'inherit',
  });
  const code = await exited(run);
  // The runner's WebKit processes are in its group: make sure none outlives it.
  await stop(run);
  return interrupted ? 130 : code;
}

let status = 1;
try {
  status = await main();
} catch (e) {
  console.error(e instanceof Abort ? e.message : e);
  status = 1;
} finally {
  await stopAll();
}
process.exit(interrupted ? 130 : status);
