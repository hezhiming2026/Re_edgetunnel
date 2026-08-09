import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { appendHistory, loadState, pruneRuns, saveRun, writeAtomicJson, writeOptimizerState } from '../src/state.js';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 're-edgetunnel-optimizer-'));
}

test('atomic JSON write leaves a complete parseable document', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'current.json');
  await writeAtomicJson(file, { revision: 'a', entries: ['104.16.0.1'] });
  const value = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(value, { revision: 'a', entries: ['104.16.0.1'] });
  const files = await readdir(dir);
  assert.equal(files.some((name) => name.includes('.tmp-')), false);
});

test('restart reloads current previous and last-good state without secrets', async () => {
  const dir = await tempDir();
  await writeOptimizerState(dir, {
    current: { revision: 'r2', entries: ['104.16.0.2'] },
    previous: { revision: 'r1', entries: ['104.16.0.1'] },
    lastGoodAdd: '104.16.0.2:443#nas-1\n',
    candidates: { last_mode: 'full', count: 192 },
  });
  const loaded = await loadState(dir);
  assert.equal(loaded.current.revision, 'r2');
  assert.equal(loaded.previous.revision, 'r1');
  assert.equal(loaded.lastGoodAdd, '104.16.0.2:443#nas-1\n');
  assert.equal(loaded.candidates.count, 192);
  const serialized = JSON.stringify(loaded);
  assert.doesNotMatch(serialized, /optimizer-token|https:\/\/secret/);
});

test('writing null optional snapshots removes stale previous and candidate files', async () => {
  const dir = await tempDir();
  await writeOptimizerState(dir, {
    current: { revision: 'r2', entries: [] },
    previous: { revision: 'r1', entries: [] },
    lastGoodAdd: '',
    candidates: { count: 10 },
  });
  await writeOptimizerState(dir, {
    current: { revision: 'r2', entries: [] },
    previous: null,
    lastGoodAdd: '',
    candidates: null,
  });
  const loaded = await loadState(dir);
  assert.equal(loaded.previous, null);
  assert.equal(loaded.candidates, null);
});

test('detailed runs are retained for 30 days and history summaries for 180 days', async () => {
  const dir = await tempDir();
  const now = new Date('2026-08-09T00:00:00Z');
  await saveRun(dir, { id: 'recent', started_at: '2026-08-01T00:00:00Z', mode: 'full' });
  await saveRun(dir, { id: 'old', started_at: '2026-06-01T00:00:00Z', mode: 'full' });
  await appendHistory(dir, { at: '2026-08-01T00:00:00Z', status: 'ok' });
  await appendHistory(dir, { at: '2026-01-01T00:00:00Z', status: 'old' });
  await pruneRuns(dir, now);

  const runs = await readdir(path.join(dir, 'runs'));
  assert.deepEqual(runs, ['recent.json']);
  const history = (await readFile(path.join(dir, 'history.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(history, [{ at: '2026-08-01T00:00:00Z', status: 'ok' }]);
});

test('state directories contain only expected writable optimizer files', async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, 'runs'), { recursive: true });
  await writeFile(path.join(dir, 'last-good-add.txt'), '104.16.0.1:443#one\n');
  const info = await stat(path.join(dir, 'runs'));
  assert.equal(info.isDirectory(), true);
});
