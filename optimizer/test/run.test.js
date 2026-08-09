import test from 'node:test';
import assert from 'node:assert/strict';
import { RevisionConflictError } from '../src/api.js';
import { runCycle } from '../src/run.js';

const currentEntries = [
  '104.16.1.1', '104.16.2.1', '104.16.3.1', '104.16.4.1',
].map((address, index) => ({ address, port: 443, name: `old-${index + 1}` }));
const newAddresses = [
  '104.16.10.1', '104.16.11.1', '104.16.12.1', '104.16.13.1',
  '104.16.14.1', '104.16.15.1', '104.16.16.1', '104.16.17.1',
];

function deps(overrides = {}) {
  let statusCalls = 0;
  const writes = [];
  const history = [];
  const savedRuns = [];
  const rollbackCalls = [];
  const publishCalls = [];
  const base = {
    loadState: async () => ({
      current: { revision: 'r1', entries: currentEntries },
      previous: null,
      lastGoodAdd: '',
      candidates: null,
    }),
    getStatus: async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { current: 'r1', previous: null, add_source: 'optimizer', add_initialized: true }
        : { current: 'r2', previous: 'r1', add_source: 'optimizer', add_initialized: true };
    },
    verifyProbe: async () => ({ ok: true, bytes: 65536 }),
    parseCidrs: () => [{ text: '104.16.0.0/13' }],
    buildCandidateSet: () => [...currentEntries.map((x) => x.address), ...newAddresses],
    probeCandidate: async ({ address }) => {
      const isNew = newAddresses.includes(address);
      return isNew
        ? { ok: true, ttfbMs: 50, totalMs: 100, bytes: 65536 }
        : { ok: true, ttfbMs: 800, totalMs: 1000, bytes: 65536 };
    },
    publishPool: async (_config, request) => {
      publishCalls.push(request);
      return { revision: 'r2', previous: 'r1', checksum: 'x'.repeat(64) };
    },
    rollback: async (_config, request) => {
      rollbackCalls.push(request);
      return { revision: 'r1', previous: 'r2' };
    },
    writeOptimizerState: async (_dir, value) => writes.push(value),
    appendHistory: async (_dir, value) => history.push(value),
    saveRun: async (_dir, value) => savedRuns.push(value),
    pruneRuns: async () => {},
    now: () => new Date('2026-08-09T08:00:00Z'),
  };
  return { ...base, ...overrides, _calls: { writes, history, savedRuns, rollbackCalls, publishCalls } };
}

function config(extra = {}) {
  return {
    dataDir: '/data',
    workerBaseUrl: 'https://edge.example.test',
    edgeHostname: 'edge.example.test',
    token: 'machine-token',
    cfIpv4Cidrs: '104.16.0.0/13',
    seeds: [],
    publishEnabled: false,
    concurrency: 4,
    probeTimeoutMs: 1000,
    fastCandidateCount: 64,
    fullCandidateCount: 192,
    ...extra,
  };
}

test('dry-run measures three rounds and never publishes', async () => {
  let probes = 0;
  const d = deps({ probeCandidate: async ({ address }) => {
    probes += 1;
    const isNew = newAddresses.includes(address);
    return isNew
      ? { ok: true, ttfbMs: 50, totalMs: 100, bytes: 65536 }
      : { ok: true, ttfbMs: 800, totalMs: 1000, bytes: 65536 };
  } });
  const result = await runCycle(config(), { mode: 'fast', deps: d });
  assert.equal(result.status, 'dry_run');
  assert.equal(probes, (currentEntries.length + newAddresses.length) * 3);
  assert.equal(d._calls.publishCalls.length, 0);
  assert.equal(d._calls.savedRuns.length, 1);
});

test('successful publish verifies authoritative revision and stores last-known-good pool', async () => {
  const d = deps();
  const result = await runCycle(config({ publishEnabled: true }), { mode: 'full', deps: d });
  assert.equal(result.status, 'published');
  assert.equal(result.revision, 'r2');
  assert.equal(d._calls.publishCalls.length, 1);
  assert.equal(d._calls.rollbackCalls.length, 0);
  assert.equal(d._calls.writes.at(-1).current.revision, 'r2');
  assert.match(d._calls.writes.at(-1).lastGoodAdd, /:443#nas-01/);
});

test('first publish may become shadow when legacy manual ADD is migrated', async () => {
  let statusCalls = 0;
  const d = deps({
    loadState: async () => ({ current: null, previous: null, lastGoodAdd: '', candidates: null }),
    getStatus: async () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { current: null, previous: null, add_source: 'none', add_initialized: false }
        : { current: 'r2', previous: null, add_source: 'manual', add_initialized: true };
    },
    publishPool: async (_config, request) => {
      d._calls.publishCalls.push(request);
      return { revision: 'r2', previous: null, checksum: 'x'.repeat(64) };
    },
  });
  const result = await runCycle(config({ publishEnabled: true }), { mode: 'fast', deps: d });
  assert.equal(result.status, 'published_shadow_manual');
  assert.equal(result.requiresManualHandoff, true);
  assert.equal(d._calls.rollbackCalls.length, 0);
});

test('existing manual override blocks subsequent automated publishes', async () => {
  const d = deps({
    getStatus: async () => ({ current: 'r1', previous: null, add_source: 'manual', add_initialized: true }),
  });
  const result = await runCycle(config({ publishEnabled: true }), { mode: 'fast', deps: d });
  assert.equal(result.status, 'manual_override_active');
  assert.equal(d._calls.publishCalls.length, 0);
});

test('post-publish verification failure rolls back only the just-published revision', async () => {
  const d = deps({ verifyProbe: async () => { throw new Error('probe failed'); } });
  const result = await runCycle(config({ publishEnabled: true }), { mode: 'fast', deps: d });
  assert.equal(result.status, 'rolled_back');
  assert.deepEqual(d._calls.rollbackCalls, [{ expectedRevision: 'r2' }]);
});

test('revision conflict is recorded without rollback', async () => {
  const d = deps({
    publishPool: async () => { throw new RevisionConflictError(); },
  });
  const result = await runCycle(config({ publishEnabled: true }), { mode: 'fast', deps: d });
  assert.equal(result.status, 'revision_conflict');
  assert.equal(d._calls.rollbackCalls.length, 0);
});

test('remote revision unknown to local state fails closed before publish', async () => {
  const d = deps({
    loadState: async () => ({ current: null, previous: null, lastGoodAdd: '', candidates: null }),
    getStatus: async () => ({ current: 'remote-r9', previous: null, add_source: 'optimizer', add_initialized: true }),
  });
  const result = await runCycle(config({ publishEnabled: true }), { mode: 'fast', deps: d });
  assert.equal(result.status, 'remote_state_unknown');
  assert.equal(d._calls.publishCalls.length, 0);
});
