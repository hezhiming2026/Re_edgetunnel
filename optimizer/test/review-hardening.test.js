import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import * as api from '../src/api.js';
import { buildCandidateSet, parseCidrs } from '../src/candidates.js';
import { acquireLock, runDaemon } from '../src/cli.js';
import { runCycle } from '../src/run.js';

const baseConfig = {
  dataDir: '/data',
  workerBaseUrl: 'https://edge.example.test',
  edgeHostname: 'edge.example.test',
  token: 'machine-token-with-sufficient-length',
  cfIpv4Cidrs: '104.16.0.0/13',
  seeds: [],
  publishEnabled: true,
  concurrency: 4,
  probeTimeoutMs: 1000,
  fastCandidateCount: 64,
  fullCandidateCount: 192,
};

function firstPublishDeps() {
  let statusCalls = 0;
  const clearCalls = [];
  return {
    loadState: async () => ({ current: null, previous: null, lastGoodAdd: '', candidates: null }),
    getStatus: async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { current: null, previous: null, add_source: 'none', add_initialized: false }
        : { current: 'r2', previous: null, add_source: 'optimizer', add_initialized: true };
    },
    parseCidrs: () => [{ text: '104.16.0.0/13' }],
    buildCandidateSet: () => ['104.16.1.1', '104.17.1.1', '104.18.1.1', '104.19.1.1'],
    probeCandidate: async () => ({ ok: true, ttfbMs: 50, totalMs: 100, bytes: 65536 }),
    publishPool: async () => ({ revision: 'r2', previous: null, checksum: 'x'.repeat(64) }),
    rollback: async () => { throw new Error('rollback must not be used without a predecessor'); },
    clearPool: async (_config, request) => {
      clearCalls.push(request);
      return { revision: null, previous: 'r2' };
    },
    verifyProbe: async () => { throw new Error('probe failed'); },
    writeOptimizerState: async () => {},
    appendHistory: async () => {},
    saveRun: async () => {},
    pruneRuns: async () => {},
    now: () => new Date('2026-08-15T12:00:00Z'),
    _clearCalls: clearCalls,
  };
}

test('failed verification of the first publish CAS-clears the just-published revision', async () => {
  const deps = firstPublishDeps();
  const result = await runCycle(baseConfig, { mode: 'fast', deps });
  assert.equal(result.status, 'cleared_failed_first_publish');
  assert.deepEqual(deps._clearCalls, [{ expectedRevision: 'r2' }]);
});

test('optimizer client exposes an expected-revision clear mutation', () => {
  assert.equal(typeof api.clearPool, 'function');
});

test('daemon survives a transient cycle error and continues on cadence', async () => {
  const calls = [];
  let sleeps = 0;
  const stop = new Error('stop-test');
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(
      () => runDaemon(baseConfig, {
        runLockedCycle: async (_config, { mode }) => {
          calls.push(mode);
          if (calls.length === 1) throw new Error('temporary outage');
          return { status: 'dry_run', mode };
        },
        sleep: async () => {
          sleeps += 1;
          if (sleeps >= 2) throw stop;
        },
        now: () => Date.parse('2026-08-15T12:00:00Z'),
      }),
      (error) => error === stop,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(calls, ['full', 'full']);
});

test('a skipped full cycle does not advance the daily full-cycle clock', async () => {
  const modes = [];
  let sleeps = 0;
  const stop = new Error('stop-test');
  const originalLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      () => runDaemon(baseConfig, {
        runLockedCycle: async (_config, { mode }) => {
          modes.push(mode);
          return modes.length === 1
            ? { status: 'skipped_locked', mode }
            : { status: 'dry_run', mode };
        },
        sleep: async () => {
          sleeps += 1;
          if (sleeps >= 2) throw stop;
        },
        now: () => Date.parse('2026-08-15T12:00:00Z'),
      }),
      (error) => error === stop,
    );
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(modes, ['full', 'full']);
});

test('releasing an old stale lock never deletes a replacement lock', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optimizer-lock-owner-'));
  const base = Date.now();
  const first = await acquireLock(dir, { staleMs: 10, now: () => base });
  assert.ok(first);
  const replacement = await acquireLock(dir, { staleMs: 10, now: () => base + 1000 });
  assert.ok(replacement);
  await first.release();
  const third = await acquireLock(dir, { staleMs: 10, now: () => base + 1001 });
  assert.equal(third, null);
  await replacement.release();
});

test('bounded API errors stop reading after the configured error-body limit', async () => {
  const originalFetch = globalThis.fetch;
  let pulls = 0;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 100) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(512).fill(65));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 500 });
  try {
    await assert.rejects(() => api.getStatus(baseConfig), /optimizer API HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(pulls <= 3, `expected bounded stream reads, got ${pulls}`);
  assert.equal(cancelled, true);
});

test('candidate target is additional sampling and never truncates current winners', () => {
  const current = [
    '104.16.1.1', '104.16.2.1', '104.16.3.1', '104.16.4.1',
    '104.16.5.1', '104.16.6.1', '104.16.7.1', '104.16.8.1',
  ];
  const result = buildCandidateSet({
    current,
    seeds: [],
    cidrs: parseCidrs('104.16.0.0/13'),
    targetCount: 4,
    rng: () => 0.25,
  });
  assert.deepEqual(result.slice(0, current.length), current);
  assert.equal(result.length, 12);
});
