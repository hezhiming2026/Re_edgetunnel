import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { acquireLock, parseArgs, readConfig, runNasCanary } from '../src/cli.js';

function env(extra = {}) {
  return {
    WORKER_BASE_URL: 'https://edge.example.test',
    EDGE_HOSTNAME: 'edge.example.test',
    OPTIMIZER_TOKEN: 'machine-token-with-sufficient-length',
    DATA_DIR: '/data',
    ...extra,
  };
}

test('configuration defaults to dry-run and bounded Stage B cadence', () => {
  const config = readConfig(env());
  assert.equal(config.publishEnabled, false);
  assert.equal(config.fastCandidateCount, 64);
  assert.equal(config.fullCandidateCount, 192);
  assert.equal(config.concurrency, 12);
  assert.ok(config.cfIpv4Cidrs.includes('104.16.0.0/13'));
});

test('publishing requires explicit PUBLISH_ENABLED=true and HTTPS Worker URL', () => {
  assert.equal(readConfig(env({ PUBLISH_ENABLED: 'true' })).publishEnabled, true);
  assert.equal(readConfig(env({ PUBLISH_ENABLED: 'TRUE' })).publishEnabled, false);
  assert.throws(() => readConfig(env({ WORKER_BASE_URL: 'http://edge.example.test' })), /HTTPS/);
  assert.throws(() => readConfig(env({ OPTIMIZER_TOKEN: 'short' })), /24/);
});

test('CLI args support fast/full, daemon, canary, and explicit dry-run', () => {
  assert.deepEqual(parseArgs(['run', '--mode', 'fast']), { command: 'run', mode: 'fast', dryRun: false });
  assert.deepEqual(parseArgs(['run', '--mode', 'full', '--dry-run']), { command: 'run', mode: 'full', dryRun: true });
  assert.deepEqual(parseArgs(['daemon']), { command: 'daemon', mode: null, dryRun: false });
  assert.deepEqual(parseArgs(['canary']), { command: 'canary', mode: null, dryRun: false });
  assert.throws(() => parseArgs(['run', '--mode', 'other']), /mode/);
});

test('local lock prevents overlapping optimizer cycles and releases cleanly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optimizer-lock-'));
  const first = await acquireLock(dir);
  assert.ok(first);
  const second = await acquireLock(dir);
  assert.equal(second, null);
  await first.release();
  const third = await acquireLock(dir);
  assert.ok(third);
  await third.release();
});

test('NAS canary verifies authenticated status and 64KiB probe without admin credential', async () => {
  const calls = [];
  const result = await runNasCanary(readConfig(env()), {
    getStatus: async () => {
      calls.push('status');
      return { current: 'r1', add_source: 'optimizer' };
    },
    verifyProbe: async () => {
      calls.push('probe');
      return { ok: true, bytes: 65536 };
    },
  });
  assert.deepEqual(calls, ['status', 'probe']);
  assert.deepEqual(result, { ok: true, revision: 'r1', add_source: 'optimizer', probe_bytes: 65536 });
});
