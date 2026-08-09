function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.min(sorted.length - 1, rank)];
}

function percentileScore(value, values, higherIsBetter) {
  if (values.length <= 1) return 1;
  const ordered = [...values].sort((a, b) => higherIsBetter ? a - b : b - a);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    if (ordered[i] === value) {
      sum += i / (ordered.length - 1);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

export function summarizeCandidate(rounds, address = '') {
  const list = Array.isArray(rounds) ? rounds : [];
  const successes = list.filter((round) => round?.ok);
  const reliability = list.length ? successes.length / list.length : 0;
  const ttfb = successes.map((round) => Number(round.ttfbMs)).filter(Number.isFinite);
  const total = successes.map((round) => Number(round.totalMs)).filter(Number.isFinite);
  const throughput = successes
    .map((round) => {
      const bytes = Number(round.bytes);
      const totalMs = Number(round.totalMs);
      return Number.isFinite(bytes) && Number.isFinite(totalMs) && totalMs > 0 ? bytes / (totalMs / 1000) : null;
    })
    .filter(Number.isFinite);
  const medianTtfbMs = median(ttfb);
  const p95TotalMs = percentile(total, 0.95);
  const throughputBps = median(throughput) || 0;
  return {
    address,
    rounds: list.length,
    successes: successes.length,
    reliability,
    medianTtfbMs,
    p95TotalMs,
    throughputBps,
    eligible: successes.length >= 2 && medianTtfbMs != null && medianTtfbMs <= 1500,
  };
}

export function scoreCandidates(summaries, currentSet = new Set()) {
  const eligible = (summaries || []).filter((item) => item?.eligible);
  const reliabilityValues = eligible.map((item) => item.reliability);
  const ttfbValues = eligible.map((item) => item.medianTtfbMs);
  const totalValues = eligible.map((item) => item.p95TotalMs);
  const throughputValues = eligible.map((item) => item.throughputBps);

  return eligible.map((item) => {
    const components = {
      reliability: percentileScore(item.reliability, reliabilityValues, true),
      ttfb: percentileScore(item.medianTtfbMs, ttfbValues, false),
      total: percentileScore(item.p95TotalMs, totalValues, false),
      throughput: percentileScore(item.throughputBps, throughputValues, true),
    };
    const score = 0.45 * components.reliability
      + 0.25 * components.ttfb
      + 0.15 * components.total
      + 0.15 * components.throughput;
    return { ...item, current: currentSet.has(item.address), components, score };
  }).sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (Math.abs(scoreDelta) > 1e-12) return scoreDelta;
    if (a.current !== b.current) return a.current ? -1 : 1;
    return String(a.address).localeCompare(String(b.address));
  });
}

export function selectPool(scored, { size = 8, maxPer24 = 2 } = {}) {
  const selected = [];
  const prefixCounts = new Map();
  for (const candidate of (scored || []).filter((item) => item?.eligible !== false)) {
    if (selected.length >= size) break;
    const octets = String(candidate.address || '').split('.');
    if (octets.length !== 4) continue;
    const prefix = octets.slice(0, 3).join('.');
    const count = prefixCounts.get(prefix) || 0;
    if (count >= maxPer24) continue;
    prefixCounts.set(prefix, count + 1);
    selected.push(candidate);
  }
  return selected;
}

function medianScore(items) {
  return median((items || []).map((item) => Number(item.score)).filter(Number.isFinite));
}

export function shouldPromote({ current = [], proposed = [] }) {
  if (proposed.length < 4) return { promote: false, reason: 'insufficient_eligible_candidates' };
  if (current.length < 4) return { promote: true, reason: 'current_pool_unhealthy' };
  const currentMedian = medianScore(current);
  const proposedMedian = medianScore(proposed);
  if (!(currentMedian > 0) || proposedMedian == null) return { promote: false, reason: 'invalid_score_baseline' };
  const improvement = (proposedMedian - currentMedian) / currentMedian;
  if (improvement + 1e-12 >= 0.15) return { promote: true, reason: 'score_improvement' };
  return { promote: false, reason: 'improvement_below_threshold' };
}

export const scoreInternals = { median, percentile, percentileScore };
