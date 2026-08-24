import path from 'node:path';
import { open, mkdir, rm, stat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runCycle } from './run.js';
import { getStatus, verifyProbe } from './api.js';
import { readConfig } from './config.js';

const FAST_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FULL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export { readConfig } from './config.js';

export function parseArgs(argv = process.argv.slice(2)) {
  const [command = 'run', ...rest] = argv;
  if (command === 'daemon' || command === 'canary') {
    if (rest.length) throw new Error(`${command} does not accept arguments`);
    return { command, mode: null, dryRun: false };
  }
  if (command !== 'run') throw new Error('command must be run, daemon, or canary');
  let mode = 'fast';
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--mode') {
      mode = rest[++index];
      if (mode !== 'fast' && mode !== 'full') throw new Error('mode must be fast or full');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { command, mode, dryRun };
}

export function logProgress(event) {
  console.log(JSON.stringify({ type: 'optimizer_progress', ...event }));
}

async function readLockToken(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed?.token === 'string' ? parsed.token : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

export async function acquireLock(dataDir, { staleMs = LOCK_STALE_MS, now = Date.now } = {}) {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'optimizer.lock');
  const tryOpen = async () => {
    const token = randomUUID();
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString(), token })}\n`, 'utf8');
      await handle.sync();
      return {
        async release() {
          try {
            await handle.close();
          } finally {
            if (await readLockToken(file) === token) await rm(file, { force: true });
          }
        },
      };
    } catch (error) {
      if (error?.code === 'EEXIST') return null;
      throw error;
    }
  };

  let lock = await tryOpen();
  if (lock) return lock;
  try {
    const info = await stat(file);
    if (now() - info.mtimeMs > staleMs) {
      await rm(file, { force: true });
      lock = await tryOpen();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    lock = await tryOpen();
  }
  return lock;
}

export async function runNasCanary(config, deps = {}) {
  const status = await (deps.getStatus || getStatus)(config);
  const probe = await (deps.verifyProbe || verifyProbe)(config);
  return {
    ok: true,
    revision: status.current ?? null,
    add_source: status.add_source || 'none',
    probe_bytes: probe.bytes,
  };
}

export async function runLockedCycle(config, { mode, dryRun = false, deps = {} } = {}) {
  const lock = await (deps.acquireLock || acquireLock)(config.dataDir);
  if (!lock) return { status: 'skipped_locked', mode };
  try {
    const runDeps = { ...(deps.runDeps || {}) };
    if (typeof deps.progress === 'function' && typeof runDeps.progress !== 'function') {
      runDeps.progress = deps.progress;
    }
    return await (deps.runCycle || runCycle)(
      { ...config, publishEnabled: dryRun ? false : config.publishEnabled },
      { mode, deps: runDeps },
    );
  } finally {
    await lock.release();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fullCycleCompleted(result) {
  return result && !['skipped_locked', 'cycle_error', 'remote_state_unknown'].includes(result.status);
}

async function runDaemonCycle(runFn, config, mode, deps) {
  try {
    const result = await runFn(config, { mode, deps });
    console.log(JSON.stringify(result));
    return result;
  } catch {
    const result = { status: 'cycle_error', mode };
    console.error(JSON.stringify({ type: 'optimizer_cycle_error', mode, error: 'cycle_failed' }));
    return result;
  }
}

export async function runDaemon(config, deps = {}) {
  const sleepFn = deps.sleep || sleep;
  const now = deps.now || Date.now;
  const runFn = deps.runLockedCycle || runLockedCycle;

  const initial = await runDaemonCycle(runFn, config, 'full', deps);
  let lastFull = fullCycleCompleted(initial) ? now() : null;

  while (true) {
    await sleepFn(FAST_INTERVAL_MS);
    const mode = lastFull === null || now() - lastFull >= FULL_INTERVAL_MS ? 'full' : 'fast';
    const result = await runDaemonCycle(runFn, config, mode, deps);
    if (mode === 'full' && fullCycleCompleted(result)) lastFull = now();
  }
}

async function main() {
  const args = parseArgs();
  const config = readConfig();
  if (args.command === 'canary') {
    console.log(JSON.stringify(await runNasCanary(config)));
  } else if (args.command === 'daemon') {
    await runDaemon(config, { progress: logProgress });
  } else {
    console.log(JSON.stringify(await runLockedCycle(config, {
      mode: args.mode,
      dryRun: args.dryRun,
      deps: { progress: logProgress },
    })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Optimizer failed: ${error?.message || 'unknown error'}`);
    process.exitCode = 1;
  });
}

export const cliConstants = { FAST_INTERVAL_MS, FULL_INTERVAL_MS, LOCK_STALE_MS };
