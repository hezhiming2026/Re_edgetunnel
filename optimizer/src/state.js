import path from 'node:path';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import crypto from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_RETENTION_MS = 30 * DAY_MS;
const HISTORY_RETENTION_MS = 180 * DAY_MS;

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readText(file, fallback = '') {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function syncDirectory(dir) {
  try {
    const handle = await open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Some filesystems do not allow fsync on directory handles. File fsync + rename
    // still prevents partial JSON documents, which is the primary invariant here.
  }
}

export async function writeAtomicJson(file, value) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  await syncDirectory(dir);
}

async function writeAtomicText(file, value) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(String(value ?? ''), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  await syncDirectory(dir);
}

function sanitizeStateObject(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeStateObject);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|base_?url|worker_?base/i.test(key)) continue;
    out[key] = sanitizeStateObject(item);
  }
  return out;
}

export async function loadState(dataDir) {
  await mkdir(path.join(dataDir, 'runs'), { recursive: true });
  return {
    current: await readJson(path.join(dataDir, 'current.json'), null),
    previous: await readJson(path.join(dataDir, 'previous.json'), null),
    lastGoodAdd: await readText(path.join(dataDir, 'last-good-add.txt'), ''),
    candidates: await readJson(path.join(dataDir, 'candidates.json'), null),
  };
}

export async function writeOptimizerState(dataDir, { current = null, previous = null, lastGoodAdd = '', candidates = null } = {}) {
  await mkdir(path.join(dataDir, 'runs'), { recursive: true });
  if (current != null) await writeAtomicJson(path.join(dataDir, 'current.json'), sanitizeStateObject(current));
  if (previous != null) await writeAtomicJson(path.join(dataDir, 'previous.json'), sanitizeStateObject(previous));
  await writeAtomicText(path.join(dataDir, 'last-good-add.txt'), lastGoodAdd);
  if (candidates != null) await writeAtomicJson(path.join(dataDir, 'candidates.json'), sanitizeStateObject(candidates));
}

export async function appendHistory(dataDir, summary) {
  await mkdir(dataDir, { recursive: true });
  const safe = sanitizeStateObject(summary);
  await appendFile(path.join(dataDir, 'history.jsonl'), `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function safeRunId(run) {
  const raw = String(run?.id || run?.started_at || new Date().toISOString());
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'run';
}

export async function saveRun(dataDir, run) {
  const runsDir = path.join(dataDir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeAtomicJson(path.join(runsDir, `${safeRunId(run)}.json`), sanitizeStateObject(run));
}

function parseRunTimestamp(run) {
  const timestamp = Date.parse(run?.started_at || run?.at || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

export async function pruneRuns(dataDir, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const runsDir = path.join(dataDir, 'runs');
  await mkdir(runsDir, { recursive: true });

  for (const name of await readdir(runsDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(runsDir, name);
    const run = await readJson(file, null);
    const ts = parseRunTimestamp(run);
    let ageBase = ts;
    if (ageBase == null) {
      const info = await stat(file);
      ageBase = info.mtimeMs;
    }
    if (nowMs - ageBase > RUN_RETENTION_MS) await rm(file, { force: true });
  }

  const historyFile = path.join(dataDir, 'history.jsonl');
  let historyText = '';
  try {
    historyText = await readFile(historyFile, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (historyText) {
    const kept = [];
    for (const line of historyText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        const ts = Date.parse(item?.at || item?.started_at || '');
        if (Number.isFinite(ts) && nowMs - ts <= HISTORY_RETENTION_MS) kept.push(JSON.stringify(item));
      } catch {
        // Corrupt historical lines are discarded rather than poisoning future cycles.
      }
    }
    await writeAtomicText(historyFile, kept.length ? `${kept.join('\n')}\n` : '');
  }
}

export const stateConstants = { RUN_RETENTION_MS, HISTORY_RETENTION_MS };
