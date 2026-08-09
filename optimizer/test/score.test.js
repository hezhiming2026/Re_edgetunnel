import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCandidate, scoreCandidates, selectPool, shouldPromote } from '../src/score.js';

function ok(ttfbMs, totalMs, bytes = 65536) {
  return { ok: true, ttfbMs, totalMs, bytes };
}
function bad() {
  return { ok: false, ttfbMs: null, totalMs: 2000, bytes: 0 };
}

test('eligibility requires at least 2/3 success and median TTFB <=1500ms', () => {
  const eligible = summarizeCandidate([ok(100, 200), ok(120, 240), bad()], '104.16.0.1');
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.successes, 2);

  const unreliable = summarizeCandidate([ok(100, 200), bad(), bad()], '104.16.0.2');
  assert.equal(unreliable.eligible, false);

  const slow = summarizeCandidate([ok(1501, 1800), ok(1700, 1900), ok(100, 200)], '104.16.0.3');
  assert.equal(slow.medianTtfbMs, 1501);
  assert.equal(slow.eligible, false);
});

test('scoring respects frozen weights and only uses current preference as a tie-breaker', () => {
  const summaries = [
    { address: '104.16.0.1', eligible: true, reliability: 1, medianTtfbMs: 100, p95TotalMs: 250, throughputBps: 300000 },
    { address: '104.16.0.2', eligible: true, reliability: 2 / 3, medianTtfbMs: 140, p95TotalMs: 320, throughputBps: 250000 },
    { address: '104.16.0.3', eligible: true, reliability: 1, medianTtfbMs: 100, p95TotalMs: 250, throughputBps: 300000 },
  ];
  const scored = scoreCandidates(summaries, new Set(['104.16.0.3']));
  const first = scored.find((x) => x.address === '104.16.0.1');
  const second = scored.find((x) => x.address === '104.16.0.2');
  const currentTie = scored.find((x) => x.address === '104.16.0.3');
  assert.equal(scored[0].address, '104.16.0.3');
  assert.equal(currentTie.score, first.score);
  assert.ok(first.score > second.score);
});

test('Top-8 selection enforces max two addresses per /24', () => {
  const scored = [];
  for (let i = 1; i <= 6; i += 1) scored.push({ address: `104.16.1.${i}`, score: 1 - i / 100, eligible: true });
  for (let i = 1; i <= 6; i += 1) scored.push({ address: `104.16.2.${i}`, score: 0.8 - i / 100, eligible: true });
  for (let i = 1; i <= 6; i += 1) scored.push({ address: `104.16.3.${i}`, score: 0.6 - i / 100, eligible: true });
  for (let i = 1; i <= 6; i += 1) scored.push({ address: `104.16.4.${i}`, score: 0.4 - i / 100, eligible: true });
  const selected = selectPool(scored, { size: 8, maxPer24: 2 });
  assert.equal(selected.length, 8);
  const counts = new Map();
  for (const item of selected) {
    const prefix = item.address.split('.').slice(0, 3).join('.');
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  assert.ok([...counts.values()].every((count) => count <= 2));
});

test('promotion gate blocks fewer than four eligible proposed entries', () => {
  const decision = shouldPromote({ current: [], proposed: [{ score: 1 }, { score: 0.9 }, { score: 0.8 }] });
  assert.deepEqual(decision, { promote: false, reason: 'insufficient_eligible_candidates' });
});

test('unhealthy current pool promotes without 15% improvement', () => {
  const current = [{ score: 0.9 }, { score: 0.8 }, { score: 0.7 }];
  const proposed = [{ score: 0.7 }, { score: 0.65 }, { score: 0.6 }, { score: 0.55 }];
  assert.deepEqual(shouldPromote({ current, proposed }), { promote: true, reason: 'current_pool_unhealthy' });
});

test('promotion threshold distinguishes 14.9% from 15.0% median improvement', () => {
  const current = [1, 1, 1, 1].map((score) => ({ score }));
  const below = [1.149, 1.149, 1.149, 1.149].map((score) => ({ score }));
  const at = [1.15, 1.15, 1.15, 1.15].map((score) => ({ score }));
  assert.deepEqual(shouldPromote({ current, proposed: below }), { promote: false, reason: 'improvement_below_threshold' });
  assert.deepEqual(shouldPromote({ current, proposed: at }), { promote: true, reason: 'score_improvement' });
});
