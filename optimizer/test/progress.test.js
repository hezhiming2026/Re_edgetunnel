import test from 'node:test';
import assert from 'node:assert/strict';
import { runCycle } from '../src/run.js';

const config = {
  dataDir: '/data',
  workerBaseUrl: 'https://edge.example.test',
  edgeHostname: 'edge.example.test',
  token: 'machine-token-with-sufficient-length',
  cfIpv4Cidrs: '104.16.0.0/13',
  seeds: [],
  publishEnabled: false,
  concurrency: 1,
  probeTimeoutMs: 1000,
  fastCandidateCount: 4,
  fullCandidateCount: 4,
};

test('measurement progress reports start and each completed round without sensitive fields', async () => {
  const events = [];
  const deps = {
    loadState: async () => ({ current: null, previous: null, lastGoodAdd: '', candidates: null }),
    getStatus: async () => ({ current: null, previous: null, add_source: 'none', add_initialized: false }),
    parseCidrs: () => [{ text: '104.16.0.0/13' }],
    buildCandidateSet: () => ['104.16.0.1', '104.16.1.1', '104.16.2.1', '104.16.3.1'],
    probeCandidate: async () => ({ ok: true, ttfbMs: 50, totalMs: 100, bytes: 65536 }),
    saveRun: async () => {},
    appendHistory: async () => {},
    pruneRuns: async () => {},
    progress: (event) => events.push(event),
    now: () => new Date('2026-08-10T00:00:00Z'),
  };

  const result = await runCycle(config, { mode: 'full', deps });
  assert.equal(result.status, 'dry_run');
  assert.deepEqual(events.map((event) => event.event), [
    'measurement_start',
    'round_complete',
    'round_complete',
    'round_complete',
  ]);
  assert.deepEqual(events.slice(1).map((event) => event.round), [1, 2, 3]);
  for (const event of events) {
    assert.equal(event.mode, 'full');
    assert.equal(event.candidate_count, 4);
    const text = JSON.stringify(event);
    assert.doesNotMatch(text, /machine-token|edge\.example\.test|104\.16\./);
  }
});
