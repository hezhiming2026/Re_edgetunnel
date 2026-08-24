# B2 Optimizer v2: Historical Stability, Confidence, and Canary Promotion

Date: 2026-08-15
Updated: 2026-08-24
Status: design review
Scope: design only; current Stage B scoring and NAS runtime are unchanged

## 1. Problem statement

Stage B intentionally starts with a simple, explainable per-cycle model: probe each candidate three times, derive reliability/TTFB/total/throughput metrics, rank eligible candidates, and apply hysteresis before publication.

That is appropriate for initial rollout, but a single cycle cannot distinguish a genuinely stable ingress from a temporarily fast ingress. The NAS now persists detailed run history, so the next version should use that evidence without turning the optimizer into an opaque or unstable learning system.

This design adds historical stability and measurement confidence while preserving these principles:

1. a recent hard failure can never be hidden by a good long-term average;
2. history should reduce churn, not make stale nodes immortal;
3. the system must remain inspectable and deterministic from local evidence;
4. shadow evaluation must simulate a continuous hypothetical v2 history, not isolated per-cycle recommendations;
5. canary experiments must retain a pinned last-known-good restoration point until the experiment is explicitly graduated.

## 2. Goals

- Use recent historical NAS measurements to distinguish stable candidates from one-cycle winners.
- Use time-aware EWMA so recent measurements matter more than old measurements.
- Represent confidence/sample maturity explicitly.
- Keep hard health/eligibility gates separate from ranking.
- Add a conservative hybrid-pool promotion stage before a substantially changed pool replaces a healthy current pool.
- Produce human-readable reasons for selection/rejection in persisted machine-readable evidence.
- Support a stateful shadow evaluation before historical scoring is allowed to mutate ADD.
- Simulate canary progression and restore behavior in shadow mode using an independent hypothetical revision lineage.

## 3. Non-goals for the current implementation slice

- Machine learning, neural models, external telemetry services, Redis, PostgreSQL, or cloud databases.
- Predicting ISP routing changes.
- Stage C destination egress selection.
- Changing Cloudflare CIDR allowlists automatically from untrusted sources.
- Traffic-percentage canaries; ADD pools do not provide deterministic weighted traffic splitting.
- Enabling v2 automatic publication before shadow evidence is reviewed.
- Implementing operator convenience commands such as `report`, `top`, `compare`, `doctor`, or `reconcile` in this slice. Those remain future operational work and are intentionally deferred.
- Changing the current seven-day fixed-seed calibration experiment or its Stage B sampling parameters.

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

How much independent temporal evidence exists for a candidate. Confidence is not the same as quality. A well-measured bad node should have high confidence that it is bad.

### Hysteresis

A deliberate threshold that prevents frequent switching when two pools are nearly equivalent. Stage B already requires a meaningful improvement before replacing a healthy pool.

### Hybrid-pool canary

A temporary ADD pool containing current-cycle-eligible retained entries plus a limited number of fully qualified challengers.

It is NOT a traffic-percentage canary: client selection/urltest behavior may send disproportionate traffic to a challenger.

### Revision lineage

An ordered version ancestry describing how a pool evolved: current revision, its predecessor, canary revision, and related state transitions.

### Shadow mode

A non-authoritative simulation in which v2 performs the same decisions and state transitions it would perform if it controlled ADD, while real Stage B/production authority remains unchanged.

### Pre-canary baseline

The pinned last-known-good pool from immediately before a canary experiment begins. It is the experiment's restoration point and is not the same as the moving `previous` revision.

## 5. Evidence sources

No new remote datastore is required.

Primary evidence:

- `/data/runs/*.json` detailed recent runs;
- `/data/history.jsonl` compact cycle summaries;
- `/data/current.json` active Stage B optimizer pool when publication is later enabled;
- `/data/previous.json` previous Stage B optimizer pool.

Derived candidate statistics may be persisted atomically in:

```text
/data/candidate-stats.json
```

Shadow state may be persisted atomically in:

```text
/data/v2-shadow-state.json
```

Both derived files MUST be non-secret and bounded. Candidate statistics MUST be rebuildable from retained detailed runs. Corrupt shadow state MUST disable shadow progression until rebuilt/reset; it MUST NOT affect Stage B measurement or production authority.

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
INELIGIBLE
```

This rule applies equally to challengers and retained current-pool entries.

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
  "dayparts_seen": 4,
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

## 8. Time-aware EWMA and two-week calibration

Per-cycle intervals are not perfectly fixed, and manual runs can occur between daemon cycles. EWMA therefore uses elapsed wall-clock time rather than assuming every observation is exactly six hours apart.

Separate EWMAs may be maintained for:

- probe reliability;
- TTFB;
- total response time;
- throughput.

The operator's first multi-week measurement window was analyzed in aggregate and recorded separately in `docs/superpowers/reports/2026-08-24-b2-optimizer-v2-two-week-calibration.md` without committing operator-specific addresses or raw data.

Initial shadow values are:

```text
EWMA_HALF_LIFE_HOURS=36
MAX_HISTORY_WEIGHT=0.30
```

These are shadow calibration values, not permanently frozen production constants. The ongoing fixed-seed window is intended to validate or adjust them.

## 9. Stability score

The stability score should be derived from historical metrics in the same direction as instant performance:

- higher reliability is better;
- lower TTFB is better;
- lower total time is better;
- higher throughput is better;
- repeated eligibility across independent cycles/dayparts is better;
- recent failures impose a penalty.

The ranking should remain relative to the current eligible candidate cohort where practical, so absolute ISP speed changes do not invalidate the scale.

## 10. Confidence model

Confidence influences how strongly history is trusted; it does not grant an independent performance bonus.

```text
historical_weight = MAX_HISTORY_WEIGHT * confidence
final_score = instant_score * (1 - historical_weight)
            + stability_score * historical_weight
```

Initial maturity guidance from the two-week calibration:

```text
low:
  < 8 independent cycles OR < 24h coverage

medium:
  >= 12 independent cycles
  >= 48h coverage
  >= 3 distinct dayparts

high:
  >= 24 independent cycles
  >= 5 days coverage
  all 4 dayparts represented

fully mature:
  >= 28 independent cycles
  >= 7 days coverage
```

A conservative initial composition is:

```text
cycle_confidence    = min(cycles_seen / 24, 1)
coverage_confidence = min(coverage_hours / 120, 1)
daypart_confidence  = min(dayparts_seen / 4, 1)
confidence          = min(cycle_confidence, coverage_confidence, daypart_confidence)
```

The fixed-seed follow-up window must be reviewed before these thresholds control real publication.

## 11. Shadow mode requires its own revision lineage

Optimizer v2 MUST first run in shadow mode and MUST maintain its own hypothetical state independently from real Stage B/production state.

A minimal shadow state is:

```json
{
  "schema_version": 1,
  "phase": "baseline|canary|promoted",
  "shadow_current": {
    "revision": "shadow-...",
    "entries": []
  },
  "shadow_previous": {
    "revision": "shadow-...",
    "entries": []
  },
  "shadow_canary": null,
  "pre_canary_baseline": null,
  "updated_at": "...",
  "reason": "..."
}
```

Shadow revisions are local hypothetical identifiers and MUST never be sent as Worker authoritative revisions.

For every scheduled cycle:

1. Stage B computes its normal real `stage_b_selected` result.
2. v2 evaluates the current measurements/history against `shadow_current`, not against the real Stage B current pool once the shadow lineages have diverged.
3. v2 computes its hypothetical transition: hold, enter canary, progress canary, promote, or restore.
4. The transition atomically updates `v2-shadow-state.json`.
5. Persist enough evidence to reconstruct why the hypothetical transition occurred.
6. Real ADD/Worker authority remains untouched.

Example divergence:

```text
real Stage B lineage:  P100 -> P101 -> P102
v2 shadow lineage:     S100 -> S101(canary) -> S102(promoted)
```

After divergence, v2 MUST NOT reset its hypothetical `current` to P101/P102 each cycle. Otherwise canary age, progression, churn, restore logic, and hysteresis cannot be meaningfully evaluated.

## 12. Promotion rules

The existing Stage B safety gates remain baseline invariants:

- minimum eligible pool size;
- `/24` diversity;
- current-pool health exception;
- hysteresis against unnecessary replacement;
- revision CAS for real publication when eventually enabled.

Optimizer v2 adds maturity constraints for challengers.

A proposed challenger should normally have:

- current-cycle eligibility;
- more than one independent observation cycle unless recovering from an unhealthy current pool;
- no recent repeated-failure streak;
- sufficient confidence for the selected promotion stage.

Emergency recovery from an unhealthy current pool must still be possible without waiting days for history, but historical reputation can never override a current hard-gate failure.

## 13. Hybrid-pool canary: retained entries must also be healthy now

The nominal healthy-pool canary target is:

```text
6 current-cycle-eligible retained entries
+
2 current-cycle-eligible mature challengers
=
8 entries
```

The implementation MUST NOT retain a currently failing old entry merely to preserve overlap.

Fallback rules:

### Six or more current entries pass hard gates

Use up to six highest-ranked eligible retained entries and up to two highest-qualified challengers, subject to `/24` diversity and all pool-level gates.

### Exactly five current entries pass hard gates

A conservative `5 + up to 3` hybrid MAY be simulated/used only if all added challengers meet the full challenger maturity gates and the resulting pool passes diversity/quality thresholds. Otherwise hold/no-publish.

### Exactly four current entries pass hard gates

Do not run a normal automatic hybrid canary. Hold/no-publish while gathering evidence unless an explicit degraded/recovery rule applies. Do not manufacture a `4 + 4` canary merely to fill eight slots.

### Fewer than four current entries pass hard gates

Treat the current pool as unhealthy and enter the separate unhealthy-recovery decision path. Recovery may replace more entries than a normal canary, but every selected replacement still must pass current hard gates and pool safety constraints.

The nominal `6 + 2` ratio is therefore a target, not a reason to carry failing retained entries.

## 14. Pin the pre-canary baseline as a restoration point

Before transitioning from a stable non-canary state into a hybrid canary, v2 MUST pin the current last-known-good pool as `pre_canary_baseline`.

Example:

```text
S100 baseline:  A B C D E F G H
S101 canary:    A B C D E F X Y
S102 promoted:  A B C D X Y Z W
```

While the experiment remains active:

```text
pre_canary_baseline = S100
```

It MUST NOT automatically advance to S101 merely because S101 becomes `shadow_previous`, and it MUST NOT advance to S102 merely because a full promotion occurs.

If the canary/promoted challengers later fail before the experiment is explicitly graduated, restore the pinned S100 baseline in the shadow simulation.

When real v2 publication is eventually enabled, restoration MUST be an expected-current-revision CAS publish (or equivalent atomic restore) of the pinned baseline entries. It MUST NOT rely on generic `rollback(previous)`, because `previous` may already contain challengers.

Only after the experiment satisfies graduation criteria may the system clear the old `pre_canary_baseline` and establish the newly proven pool as the next last-known-good baseline.

This is the optimizer equivalent of a system restore point created before a risky upgrade.

## 15. Canary observation, promotion, and graduation

A hybrid pool becomes eligible for hypothetical/real full promotion only after evidence such as:

- at least one subsequent scheduled measurement cycle;
- challengers remain current-cycle eligible;
- retained entries used in the next transition remain current-cycle eligible;
- no material degradation of pool-level health;
- the current hypothetical/real revision is the expected canary revision;
- initial real rollout includes a client sanity check.

Promotion does not automatically erase `pre_canary_baseline`.

Graduation is a distinct transition after sufficient post-promotion observation. Only graduation declares the new pool last-known-good and clears/replaces the old restore point.

If challengers fail before graduation:

- restore `pre_canary_baseline` using the appropriate shadow transition or real CAS publish;
- mark challengers with recent-failure evidence;
- do not permanently blacklist them; history can recover after later evidence.

## 16. Shadow transition contract

The shadow state machine should support at least:

```text
baseline_hold
baseline_to_canary
canary_hold
canary_to_promoted
canary_restore_baseline
promoted_hold_observation
promoted_graduate
promoted_restore_baseline
unhealthy_recovery
```

Every transition records:

- prior shadow revision;
- resulting shadow revision;
- phase;
- selected entries;
- pinned pre-canary baseline revision if present;
- reason code;
- current pool health summary;
- Stage B-v2 overlap count;
- no secrets.

Invalid or impossible transitions fail closed in shadow state and do not affect Stage B measurement.

## 17. Pool-level comparison

Promotion should compare pools, not only individual top candidates.

Useful pool statistics include:

- median final score;
- minimum reliability among selected entries;
- number of distinct `/24` prefixes;
- number of newcomers;
- overlap with shadow current pool;
- selected candidates with low confidence;
- number of retained entries that pass current hard gates.

A high median score must not compensate for a currently failing selected entry.

## 18. Explainability and persisted evidence

Every shadow cycle should persist enough compact JSON evidence to explain a decision without reading source code.

Example:

```json
{
  "decision": "baseline_to_canary",
  "shadow_revision": "shadow-102",
  "shadow_parent_revision": "shadow-101",
  "pre_canary_baseline_revision": "shadow-101",
  "current_pool_healthy": true,
  "eligible_retained": 6,
  "challengers": 2,
  "pool_overlap": 6,
  "improvement": 0.18,
  "reason": "stable improvement above hysteresis with mature challengers"
}
```

Candidate components may include instant/stability/confidence/historical-weight/final-score fields.

No new human-facing CLI reporting commands are required in this implementation slice; the persisted JSON is the contract needed for later analysis tooling.

## 19. Adaptive sampling remains a later shadow feature

The first multi-week measurement window showed strongly non-uniform prefix productivity and sparse per-IP repeat coverage. The calibration addendum therefore recommends future adaptive stratified sampling with a non-zero exploration budget.

However, the current seven-day fixed-seed experiment intentionally freezes Stage B sampling. Adaptive sampling MUST NOT be enabled during this window.

After the fixed-seed evidence is reviewed, a later shadow sampler may target roughly:

```text
70–80% exploitation of productive strata/fixed seeds
20–30% unbiased full-range exploration
```

Sampling remains separate from eligibility/scoring and never authorizes publication by itself.

## 20. Data retention

Current detailed-run retention (30 days) and compact history retention (180 days) remain sufficient initially.

Derived candidate and shadow state must be bounded. Candidate entries not observed for a configured aging interval should be pruned after their influence decays.

No unbounded per-probe append-only file is introduced.

## 21. Failure behavior

- Corrupt derived candidate history: rebuild from detailed runs; do not publish based on corrupt history.
- Corrupt shadow state: stop/reset shadow progression; continue Stage B measurements.
- Insufficient history: v2 ranking falls back toward Stage B instant score through low confidence.
- Historical parser error: fail v2 shadow computation but allow Stage B measurement history to continue.
- Current hard-gate failure: candidate is ineligible regardless of history or retained/incumbent status.
- Shadow lineage mismatch: fail the hypothetical transition; do not silently rebase onto real Stage B current.
- Real revision conflict after eventual activation: do not retry/overwrite.
- NAS state loss: remote-state reconciliation remains separate future hardening; v2 must not guess remote authority.

## 22. TDD / evidence plan

Implementation order:

1. pure time-aware EWMA tests;
2. candidate-history aggregation tests;
3. confidence/maturity tests;
4. final-score blending tests;
5. hard-gate precedence tests for both challengers and retained entries;
6. shadow revision-lineage transition tests;
7. shadow divergence-from-Stage-B tests;
8. hybrid retained-count fallback tests (`6+2`, guarded `5+3`, no normal `4+4`);
9. pre-canary-baseline pinning tests;
10. canary promotion/graduation/restore tests;
11. real restore contract tests using expected-revision CAS interfaces without enabling production publication;
12. bounded persistence/corruption tests;
13. NAS Docker runtime validation.

No production publish behavior changes until shadow-mode evidence is reviewed.

## 23. Acceptance gates before v2 controls publication

- Stage B remains the authoritative selector during shadow collection.
- v2 maintains an independent shadow revision lineage after the first divergence.
- shadow canary age/progression is evaluated against shadow state, not real Stage B state.
- `pre_canary_baseline` remains pinned through canary and post-promotion observation until explicit graduation.
- a restore before graduation returns to that pinned baseline, not merely `previous`.
- no candidate with current hard-gate failure is selected due to history or incumbent status.
- normal hybrid canary does not retain failing old entries to satisfy a fixed ratio.
- confidence cannot improve a bad performance score merely by sample count.
- v2 decisions are reproducible from persisted evidence.
- real rollback/restore design remains revision-CAS protected.
- no new secrets are persisted.
- CPU, memory, and disk growth remain bounded on the NAS.
- current seven-day fixed-seed experiment remains unmodified.

## 24. Calibration decisions and remaining empirical values

The first multi-week aggregate calibration recommends these initial shadow values:

```text
EWMA_HALF_LIFE_HOURS=36
MAX_HISTORY_WEIGHT=0.30
```

Confidence maturity starts from the thresholds in section 10.

Still empirical until the fixed-seed follow-up window is reviewed:

- 36h versus nearby EWMA half-lives;
- confidence maturity thresholds;
- required canary observation duration before promotion/graduation;
- exact conditions under which guarded `5+3` is preferable to hold/no-publish;
- adaptive sampler exploitation/exploration ratio.

These are operational calibration parameters. They do not weaken the safety invariants above.
