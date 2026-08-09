import { parseCidrs, buildCandidateSet } from './candidates.js';
import { probeCandidate } from './probe.js';
import { summarizeCandidate, scoreCandidates, selectPool, shouldPromote } from './score.js';
import { loadState, writeOptimizerState, appendHistory, saveRun, pruneRuns } from './state.js';
import { getStatus, publishPool, rollback, verifyProbe, RevisionConflictError } from './api.js';

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function runId(now, mode) {
  return `${iso(now).replace(/[-:.]/g, '')}-${mode}`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(items.length || 1, Math.floor(limit) || 1)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function poolEntries(selected) {
  return selected.map((item, index) => ({
    address: item.address,
    port: 443,
    name: `nas-${String(index + 1).padStart(2, '0')}`,
  }));
}

function addTxt(entries) {
  return entries.map((entry) => `${entry.address}:443#${entry.name}`).join('\n') + (entries.length ? '\n' : '');
}

function statusSummary({ mode, at, candidates, scored, selected, decision, status }) {
  return {
    at,
    mode,
    status,
    candidate_count: candidates.length,
    eligible_count: scored.length,
    selected_count: selected.length,
    decision: decision?.reason || null,
  };
}

function defaultDeps(overrides = {}) {
  return {
    parseCidrs,
    buildCandidateSet,
    probeCandidate,
    summarizeCandidate,
    scoreCandidates,
    selectPool,
    shouldPromote,
    loadState,
    writeOptimizerState,
    appendHistory,
    saveRun,
    pruneRuns,
    getStatus,
    publishPool,
    rollback,
    verifyProbe,
    progress: () => {},
    now: () => new Date(),
    ...overrides,
  };
}

async function persist(deps, config, detail, summary) {
  await deps.saveRun(config.dataDir, detail);
  await deps.appendHistory(config.dataDir, summary);
  await deps.pruneRuns(config.dataDir, deps.now());
}

export async function runCycle(config, { mode = 'fast', deps: injected = {} } = {}) {
  if (mode !== 'fast' && mode !== 'full') throw new Error(`Unsupported optimizer mode: ${mode}`);
  const deps = defaultDeps(injected);
  const started = deps.now();
  const startedAt = iso(started);
  const state = await deps.loadState(config.dataDir);
  const remote = await deps.getStatus(config);

  const localRevision = state.current?.revision ?? null;
  if (remote.current !== localRevision) {
    const result = {
      status: 'remote_state_unknown',
      mode,
      remoteRevision: remote.current ?? null,
      localRevision,
    };
    const detail = { id: runId(started, mode), started_at: startedAt, mode, result };
    await persist(deps, config, detail, { at: startedAt, mode, status: result.status });
    return result;
  }

  const cidrs = deps.parseCidrs(config.cfIpv4Cidrs);
  const currentAddresses = (state.current?.entries || []).map((entry) => entry.address);
  const candidateTarget = mode === 'full'
    ? Number(config.fullCandidateCount || 192)
    : Number(config.fastCandidateCount || 64);
  const candidates = deps.buildCandidateSet({
    current: currentAddresses,
    seeds: config.seeds || [],
    cidrs,
    targetCount: candidateTarget,
  });

  deps.progress({ event: 'measurement_start', mode, candidate_count: candidates.length, rounds: 3 });
  const rounds = new Map(candidates.map((address) => [address, []]));
  for (let round = 0; round < 3; round += 1) {
    const measured = await mapLimit(candidates, Number(config.concurrency || 12), async (address) => {
      try {
        return await deps.probeCandidate({
          address,
          hostname: config.edgeHostname,
          token: config.token,
          timeoutMs: Number(config.probeTimeoutMs || 5000),
          payloadPath: '/ops/optimizer/v1/probe',
        });
      } catch {
        return { ok: false, error: 'probe_exception', ttfbMs: null, totalMs: null, bytes: 0 };
      }
    });
    measured.forEach((result, index) => rounds.get(candidates[index]).push(result));
    deps.progress({ event: 'round_complete', mode, candidate_count: candidates.length, round: round + 1, rounds: 3 });
  }

  const summaries = candidates.map((address) => deps.summarizeCandidate(rounds.get(address), address));
  const currentSet = new Set(currentAddresses);
  const scored = deps.scoreCandidates(summaries, currentSet);
  const selected = deps.selectPool(scored, { size: 8, maxPer24: 2 });
  const currentScored = scored.filter((item) => currentSet.has(item.address));
  const decision = deps.shouldPromote({ current: currentScored, proposed: selected });
  const entries = poolEntries(selected);
  const detailBase = {
    id: runId(started, mode),
    started_at: startedAt,
    mode,
    remote_revision: remote.current ?? null,
    add_source: remote.add_source || 'none',
    candidates: summaries,
    selected: selected.map((item) => ({ address: item.address, score: item.score })),
    decision,
  };

  if (!config.publishEnabled) {
    const result = { status: 'dry_run', mode, decision, selected: entries };
    await persist(deps, config, { ...detailBase, result }, statusSummary({ mode, at: startedAt, candidates, scored, selected, decision, status: result.status }));
    return result;
  }

  if (remote.add_source === 'manual' && remote.current) {
    const result = { status: 'manual_override_active', mode, decision, selected: entries, requiresManualHandoff: true };
    await persist(deps, config, { ...detailBase, result }, statusSummary({ mode, at: startedAt, candidates, scored, selected, decision, status: result.status }));
    return result;
  }

  if (!decision.promote) {
    const result = { status: 'no_change', mode, decision, selected: entries };
    await persist(deps, config, { ...detailBase, result }, statusSummary({ mode, at: startedAt, candidates, scored, selected, decision, status: result.status }));
    return result;
  }

  let published;
  try {
    published = await deps.publishPool(config, {
      expectedRevision: remote.current ?? null,
      entries,
    });
  } catch (error) {
    if (error instanceof RevisionConflictError || error?.code === 'REVISION_CONFLICT') {
      const result = { status: 'revision_conflict', mode, decision };
      await persist(deps, config, { ...detailBase, result }, statusSummary({ mode, at: startedAt, candidates, scored, selected, decision, status: result.status }));
      return result;
    }
    throw error;
  }

  try {
    const postStatus = await deps.getStatus(config);
    if (postStatus.current !== published.revision) throw new Error('published revision did not become authoritative');
    await deps.verifyProbe(config);
    if (postStatus.add_source !== 'optimizer' && postStatus.add_source !== 'manual') {
      throw new Error('published pool has no effective ADD source');
    }

    const newCurrent = {
      revision: published.revision,
      entries,
      median_score: median(selected.map((item) => item.score).filter(Number.isFinite)),
      published_at: startedAt,
    };
    const shadow = postStatus.add_source === 'manual';
    await deps.writeOptimizerState(config.dataDir, {
      current: newCurrent,
      previous: state.current,
      lastGoodAdd: shadow ? state.lastGoodAdd : addTxt(entries),
      candidates: { last_mode: mode, count: candidates.length, at: startedAt },
    });
    const result = shadow
      ? { status: 'published_shadow_manual', mode, revision: published.revision, requiresManualHandoff: true }
      : { status: 'published', mode, revision: published.revision };
    await persist(deps, config, { ...detailBase, post_status: { current: postStatus.current, add_source: postStatus.add_source }, result }, statusSummary({ mode, at: startedAt, candidates, scored, selected, decision, status: result.status }));
    return result;
  } catch (verificationError) {
    if (!published.previous) {
      const result = { status: 'verification_failed_no_rollback', mode, revision: published.revision };
      await persist(deps, config, { ...detailBase, result, verification_error: 'post_publish_verification_failed' }, statusSummary({ mode, at: startedAt, candidates, scored, selected, decision, status: result.status }));
      return result;
    }
    try {
      const rolled = await deps.rollback(config, { expectedRevision: published.revision });
      await deps.writeOptimizerState(config.dataDir, {
        current: state.current,
        previous: { revision: published.revision, entries },
        lastGoodAdd: state.lastGoodAdd,
        candidates: { last_mode: mode, count: candidates.length, at: startedAt },
      });
      const result = { status: 'rolled_back', mode, revision: rolled.revision };
      await persist(deps, config, { ...detailBase, result, verification_error: 'post_publish_verification_failed' }, statusSummary({ mode, at: startedAt, candidates, scored, selected, decision, status: result.status }));
      return result;
    } catch (rollbackError) {
      if (rollbackError instanceof RevisionConflictError || rollbackError?.code === 'REVISION_CONFLICT') {
        const result = { status: 'rollback_conflict', mode, revision: published.revision };
        await persist(deps, config, { ...detailBase, result }, statusSummary({ mode, at: startedAt, candidates, scored, selected, decision, status: result.status }));
        return result;
      }
      throw rollbackError;
    }
  }
}

export const runInternals = { mapLimit, poolEntries, addTxt };
