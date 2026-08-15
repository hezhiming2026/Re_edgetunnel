# B2 Optimizer v2: Historical Stability, Confidence, and Canary Promotion

Date: 2026-08-15
Status: design review
Scope: design only; current Stage B scoring and NAS runtime are unchanged

## 1. Problem statement

Stage B intentionally starts with a simple, explainable per-cycle model: probe each candidate three times, derive reliability/TTFB/total/throughput metrics, rank eligible candidates, and apply hysteresis before publication.

That is appropriate for initial rollout, but a single cycle cannot distinguish a genuinely stable ingress from a temporarily fast ingress. The NAS now persists detailed run history, so the next version should use that evidence without turning the optimizer into an opaque or unstable learning system.

This design adds historical stability and measurement confidence while preserving three principles:

1. a recent hard failure can never be hidden by a good long-term average;
2. history should reduce churn, not make stale nodes immortal;
3. the system must remain inspectable and deterministic from local evidence.

## 2. Goals

- Use recent historical NAS measurements to distinguish stable candidates from one-cycle winners.
- Use time-aware EWMA so recent measurements matter more than old measurements.
- Represent confidence/sample maturity explicitly.
- Keep hard health/eligibility gates separate from ranking.
- Add a conservative hybrid-pool promotion stage before a completely new pool replaces a healthy current pool.
- Produce human-readable explanations for why a candidate was selected or rejected.
- Support shadow evaluation before historical scoring is allowed to mutate ADD.

## 3. Non-goals

- Machine learning, neural models, external telemetry services, Redis, PostgreSQL, or cloud databases.
- Predicting ISP routing changes.
- Stage C destination egress selection.
- Changing Cloudflare CIDR allowlists automatically from untrusted sources.
- Traffic-percentage canaries; ADD pools do not provide deterministic weighted traffic splitting.

## 4. Terminology

### Instant score

The score calculated from the current cycle only. Stage B already uses reliability, median TTFB, p95 total time, and throughput.

### Stability

How consistently a candidate has remained healthy and performant across multiple cycles and time periods.

### EWMA

Exponentially Weighted Moving Average. New measurements receive more weight than older measurements, while old evidence decays gradually instead of disappearing at a fixed boundary.

A time-aware form is preferred:

```text
decay = exp(-ln(2) * elapsed_time / half_life)
EWMA_new = decay * EWMA_old + (1 - decay) * measurement
```

`half_life` is the time required for old evidence to lose half its influence. It MUST be a documented configuration value, not an implicit magic constant.

### Confidence

How much evidence exists for a candidate. Confidence is not the same as quality. A well-measured bad node should have high confidence that it is bad.

### Hysteresis

A deliberate threshold that prevents frequent switching when two pools are nearly equivalent. Stage B already requires a meaningful improvement before replacing a healthy pool.

### Hybrid-pool canary

A temporary ADD pool containing mostly known-good current entries plus a small number of challengers. This exposes new entries gradually at configuration level.

It is NOT a traffic-percentage canary: client selection/urltest behavior may send disproportionate traffic to a challenger.

## 5. Evidence sources

No new remote datastore is required.

Primary evidence:

- `/data/runs/*.json` detailed recent runs;
- `/data/history.jsonl` compact cycle summaries;
- `/data/current.json` active optimizer pool;
- `/data/previous.json` previous optimizer pool.

Derived candidate statistics may be persisted atomically in a new compact file such as:

```text
/data/candidate-stats.json
```

The derived file MUST be rebuildable from retained detailed runs. Losing it must not prevent dry-run measurement.

## 6. Keep hard eligibility separate from historical ranking

Historical success must never rescue a currently unhealthy candidate.

A candidate first passes current-cycle hard gates, including at minimum:

- at least 2 successful probes out of 3;
- current median TTFB within the configured eligibility bound;
- valid TLS/probe contract;
- allowed Cloudflare CIDR;
- no disqualifying current-cycle network error pattern.

Only candidates that pass current hard gates are ranked using historical evidence.

Example:

```text
7 days excellent history
+
current cycle 0/3 success
=
INELIGIBLE, not "temporarily discounted"
```

This is a fail-safe property.

## 7. Historical candidate state

For each candidate address maintain non-secret, bounded fields such as:

```json
{
  "address": "192.0.2.1",
  "first_seen_at": "...",
  "last_seen_at": "...",
  "cycles_seen": 12,
  "successful_cycles": 11,
  "probe_successes": 34,
  "probe_attempts": 36,
  "ewma_reliability": 0.98,
  "ewma_ttfb_ms": 73.4,
  "ewma_total_ms": 128.0,
  "ewma_throughput_bps": 1234567,
  "top8_count": 7,
  "consecutive_eligible": 5,
  "consecutive_failures": 0
}
```

No hostname, token, Worker base URL, Access secret, or other runtime credential is stored in historical candidate state.

## 8. Time-aware EWMA

Per-cycle intervals are not perfectly fixed, and manual runs can occur between daemon cycles. Therefore EWMA must use elapsed wall-clock time rather than assuming every observation is exactly six hours apart.

Separate EWMAs may be maintained for:

- probe reliability;
- TTFB;
- total response time;
- throughput.

A single half-life may be used initially for simplicity, but the implementation should make it explicit/configurable.

Initial recommendation for shadow evaluation: 48-hour half-life.

This value is not considered permanently frozen until real NAS history is compared under shadow mode.

## 9. Stability score

The stability score should be derived from historical metrics in the same direction as instant performance:

- higher reliability is better;
- lower TTFB is better;
- lower total time is better;
- higher throughput is better;
- repeated eligibility is better;
- recent failures impose a penalty.

The ranking should remain relative to the current eligible candidate cohort where practical, so absolute ISP speed changes do not invalidate the scale.

A candidate's history must age out naturally through EWMA decay and detailed-run retention.

## 10. Confidence model

Confidence should influence how strongly history is trusted, not grant an independent performance bonus.

Preferred model:

```text
historical_weight = MAX_HISTORY_WEIGHT * confidence
final_score = instant_score * (1 - historical_weight)
            + stability_score * historical_weight
```

This is preferable to adding `+ confidence_bonus`, because a frequently measured but mediocre node should not outrank a better node merely because it has more samples.

Confidence inputs may include:

- number of independent cycles seen;
- elapsed coverage period;
- probe attempts;
- presence across multiple dayparts;
- consecutive recent eligible cycles.

Confidence is capped at 1.0.

Before a minimum maturity gate is reached, `historical_weight` remains low and the current-cycle score dominates.

## 11. Shadow mode before behavioral activation

Optimizer v2 MUST first run in shadow mode.

For each cycle, persist both:

- `stage_b_selected`: pool chosen by current Stage B algorithm;
- `v2_shadow_selected`: pool v2 would choose;
- per-candidate instant/stability/confidence/final components;
- pool overlap count;
- reason for every material difference.

Shadow mode MUST NOT alter ADD publication decisions.

The operator should be able to compare several days of real history before enabling v2 ranking.

## 12. Promotion rules

The existing Stage B safety gates remain the baseline:

- minimum eligible pool size;
- `/24` diversity;
- current-pool health exception;
- hysteresis against unnecessary replacement;
- revision CAS.

Optimizer v2 adds maturity constraints for new challengers.

A proposed newcomer should normally have:

- current-cycle eligibility;
- more than one independent observation cycle unless recovering from an unhealthy current pool;
- no recent repeated-failure streak;
- sufficient confidence for the selected promotion stage.

Emergency recovery from an unhealthy current pool must still be possible without waiting days for history.

## 13. Hybrid-pool canary

When a healthy current pool exists and a materially better v2 pool contains several newcomers, do not immediately replace all eight entries.

Suggested first-stage hybrid:

```text
6 retained known-good current entries
+
2 highest-confidence challengers
=
8-entry hybrid pool
```

The exact retained/challenger counts should be configurable and subject to `/24` diversity.

Important limitation: this is configuration canarying, not traffic weighting. A client's URL test may choose one challenger for most traffic. Therefore challengers still must independently satisfy all safety gates before entering the hybrid pool.

## 14. Canary observation and promotion

A hybrid pool becomes eligible for full promotion only after evidence such as:

- at least one subsequent scheduled measurement cycle;
- challengers remain eligible;
- no material degradation of current pool health;
- real client sanity check during the initial manual rollout phase;
- revision remains the expected canary revision.

After the feature is proven, scheduled canary progression may become automatic, but first rollout remains controlled/manual.

If challengers fail:

- publish/restore the known-good prior pool using revision CAS;
- mark challengers with recent-failure evidence;
- do not permanently blacklist them; EWMA/history can recover after later evidence.

## 15. Pool-level comparison

Promotion should compare pools, not only individual top candidates.

Useful pool statistics include:

- median final score;
- minimum reliability among selected entries;
- number of distinct `/24` prefixes;
- number of newcomers;
- overlap with current pool;
- selected candidates with low confidence.

A high median score should not compensate for one obviously fragile entry if an equally good stable alternative exists.

## 16. Explainability contract

Every cycle should be able to explain a decision without reading source code.

Example compact result:

```json
{
  "decision": "hybrid_canary",
  "current_pool_healthy": true,
  "pool_overlap": 6,
  "challengers": 2,
  "improvement": 0.18,
  "reason": "stable improvement above hysteresis with mature challengers"
}
```

Candidate detail may include:

```json
{
  "address": "192.0.2.1",
  "instant_score": 0.81,
  "stability_score": 0.76,
  "confidence": 0.72,
  "historical_weight": 0.25,
  "final_score": 0.7975,
  "eligible": true
}
```

## 17. CLI/reporting additions

Implementation should add read-only operational commands before automatic v2 publication, for example:

```text
optimizer report --days 7
optimizer top --days 7
optimizer compare --days 7
```

Desired outputs:

- repeated Top-8 frequency;
- candidate success rate;
- TTFB/throughput stability;
- Stage B vs v2 overlap;
- low-confidence challengers;
- recent failure streaks.

Machine-readable JSON output should be available for analysis without scraping human log text.

## 18. Data retention

Current detailed-run retention (30 days) and compact history retention (180 days) remain sufficient initially.

Derived state must be bounded. Candidate entries not observed for a configured aging interval should be pruned after their influence has decayed.

No unbounded per-probe append-only file is introduced.

## 19. Failure behavior

- Corrupt derived candidate history: rebuild from detailed runs; do not publish based on corrupt history.
- Insufficient history: fall back to Stage B instant scoring.
- Historical parser error: fail v2 shadow computation but allow measurement history to continue.
- Current hard-gate failure: candidate ineligible regardless of history.
- Revision conflict: do not retry/overwrite.
- NAS state loss: existing remote-state reconciliation design remains a separate hardening item; v2 must not guess remote authority.

## 20. TDD / evidence plan

Implementation order:

1. pure time-aware EWMA tests;
2. candidate-history aggregation tests;
3. confidence/maturity tests;
4. final-score blending tests;
5. hard-gate precedence tests;
6. shadow Stage B-v2 comparison tests;
7. hybrid-pool selection tests;
8. canary rollback/CAS tests;
9. bounded persistence/rebuild tests;
10. CLI report tests;
11. NAS Docker runtime validation.

No production publish behavior changes until shadow-mode evidence is reviewed.

## 21. Acceptance gates before v2 controls publication

- Stage B remains the authoritative selector during shadow collection.
- At least several independent scheduled cycles are available from the real NAS network.
- v2 decisions are reproducible from persisted evidence.
- no candidate with current hard-gate failure is selected due to history.
- confidence cannot improve a bad performance score merely by sample count.
- hybrid-pool canary retains known-good entries when current pool is healthy.
- rollback remains revision-CAS protected.
- no new secrets are persisted.
- CPU, memory, disk growth remain bounded on the NAS.

## 22. Decisions intentionally left empirical

The model architecture is specified here, but the following numeric values should be calibrated against real NAS history before activation:

- EWMA half-life (48h is the initial shadow recommendation);
- maximum historical weight;
- confidence maturity thresholds;
- required canary observation duration;
- exact hybrid retained/challenger ratio if evidence suggests 6+2 is too conservative or too aggressive.

These are operational calibration parameters, not reasons to change the safety invariants above.
