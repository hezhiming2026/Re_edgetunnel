# B2 Optimizer v2: Historical Stability, Confidence, and Canary Promotion

Date: 2026-08-15
Updated: 2026-08-24
Status: design review
Scope: design only; current Stage B scoring and current seven-day fixed-seed experiment are unchanged

## 1. Problem statement

Stage B intentionally uses a simple per-cycle model: probe each candidate three times, derive reliability/TTFB/total/throughput metrics, rank eligible candidates, and apply hysteresis before publication.

Optimizer v2 adds historical stability, confidence, shadow evaluation, and conservative canary progression. The design must preserve these invariants:

1. current-cycle hard failures can never be hidden by historical reputation;
2. history reduces churn but never makes stale nodes immortal;
3. shadow mode simulates a continuous hypothetical v2 world, not isolated recommendations;
4. every shadow-current or production-restore entry used for a decision has current-cycle measurement evidence;
5. every newcomer enters an observed canary state before it can become a graduated stable pool, including unhealthy recovery;
6. a pre-canary restore point stays pinned and continuously measured until the experiment is explicitly graduated or terminated;
7. restoring a baseline is permitted only if that baseline is still currently safe;
8. graduation is allowed only while the observed promoted revision/pool is still exactly the one under experiment;
9. `instant_score` and `stability_score` are deterministic bounded scores on the same `[0,1]` scale before blending;
10. EWMA state is rebuildable bit-for-bit from the same ordered retained run summaries under one frozen update contract;
11. a healthy pool is not replaced for a marginal ranking change: explicit v2 hysteresis gates every normal canary transition;
12. a failed canary cannot immediately restart merely because another scheduled cycle completed;
13. shadow revisions and restore points are evidence only; production activation starts by pinning the real authoritative pool actually being replaced.

## 2. Goals

- Use recent historical NAS measurements to distinguish stable candidates from one-cycle winners.
- Use time-aware EWMA with bounded historical influence.
- Represent confidence/sample maturity explicitly.
- Keep current hard health gates separate from historical ranking.
- Maintain an independent v2 shadow revision lineage after divergence from Stage B.
- Add configuration-level hybrid canaries before substantial pool replacement.
- Support multiple canary waves when more newcomers are desired than one safe wave allows.
- Make unhealthy recovery an explicit observed recovery-canary, not an unobserved promotion shortcut.
- Persist deterministic, non-secret evidence for each hypothetical or real transition.
- Keep real ADD publication disabled until shadow evidence is reviewed.

## 3. Non-goals for this slice

- Machine learning or external telemetry databases.
- Stage C destination-egress selection.
- Changing Cloudflare CIDR allowlists from untrusted sources.
- Traffic-percentage canaries; ADD pools do not provide deterministic weighted traffic splitting.
- Automatic v2 publication before shadow evidence is reviewed.
- `report`, `top`, `compare`, `doctor`, or `reconcile` convenience tooling.
- Adaptive sampling during the current seven-day fixed-seed experiment.

## 4. Terminology

### Instant score

Score from the current cycle only, using the existing Stage B bounded percentile-component score.

### Stability score

Historical quality derived from EWMA reliability, TTFB, total-time, and throughput, normalized into the same bounded `[0,1]` scoring model as instant score before blending.

### Confidence

How much independent temporal evidence exists. Confidence changes how much history is trusted; it is not an additive quality bonus.

### EWMA

Time-aware exponentially weighted moving average:

```text
decay = exp(-ln(2) * elapsed_time / half_life)
EWMA_new = decay * EWMA_old + (1 - decay) * measurement
```

### Hysteresis

A minimum material pool-level improvement required before a healthy current pool may enter a normal canary.

### Shadow mode

A non-authoritative simulation where v2 performs the state transitions it would perform if it controlled ADD, while real Stage B/Worker authority remains unchanged.

### Shadow revision lineage

The hypothetical ancestry of v2 pools (`shadow_current`, `shadow_previous`, canary revision, promotion revision), independent from real Stage B revisions.

### Pre-canary baseline

The pinned last-known-good pool from immediately before a canary experiment. In shadow mode it is hypothetical; in production it is authoritative state actually served before the experiment.

### Canary wave

One observed configuration step introducing a bounded set of newcomers. A later wave may introduce additional newcomers only after the prior wave has been observed/proven.

### Recovery canary

The first authoritative recovery configuration used when the current pool is unhealthy. It may be published without the normal healthy-pool improvement threshold, but it remains an ungraduated canary state and must pass observation/client-sanity gates before it can become the new stable baseline.

### Authoritative activation baseline

The real Worker-authoritative revision, canonical entries, and fingerprint read and pinned immediately before v2's first production canary mutation. It is never copied from shadow lineage.

## 5. Evidence and persisted state

Primary local evidence:

- `/data/runs/*.json`;
- `/data/history.jsonl`;
- `/data/current.json` / `previous.json` for Stage B authority when publication is eventually used.

Derived non-secret files:

```text
/data/candidate-stats.json
/data/v2-shadow-state.json
```

Candidate statistics must be rebuildable from retained detailed runs. Corrupt shadow state stops shadow progression but does not stop Stage B measurement.

Minimal shadow state:

```json
{
  "schema_version": 1,
  "phase": "baseline|canary|recovery_canary|promoted_observation|graduated|restore_blocked",
  "shadow_current": {"revision":"shadow-...","entries":[],"fingerprint":"..."},
  "shadow_previous": null,
  "shadow_canary": null,
  "promoted_experiment": null,
  "pre_canary_baseline": null,
  "failed_canaries": {},
  "canary_wave": 0,
  "updated_at":"...",
  "reason":"..."
}
```

Fingerprints are deterministic hashes of canonicalized selected entries and verify that the pool being observed is the pool later promoted/graduated/restored.

Production-mode state additionally persists the currently applicable authoritative restore baseline. It MUST be initialized from a fresh authoritative read and must never be synthesized from shadow state.

## 6. Current hard eligibility always wins

A candidate first passes current-cycle hard gates, including at minimum:

- at least 2 successful probes out of 3;
- median TTFB inside the configured bound;
- valid TLS/probe contract;
- allowed Cloudflare CIDR;
- no disqualifying current-cycle error pattern.

Only current-cycle-eligible candidates may participate in ranking, retention, canary, recovery-canary, promotion, restore, or graduation.

```text
excellent 7-day history + current 0/3 = INELIGIBLE
```

This applies to challengers, Stage B winners, shadow incumbents, normal canaries, recovery canaries, and every pinned baseline member.

## 7. Historical candidate state

Per address, maintain bounded non-secret fields such as:

```json
{
  "address":"192.0.2.1",
  "first_seen_at":"...",
  "last_seen_at":"...",
  "cycles_seen":12,
  "successful_cycles":11,
  "probe_successes":34,
  "probe_attempts":36,
  "dayparts_seen":4,
  "ewma_reliability":0.98,
  "ewma_ttfb_ms":73.4,
  "ewma_total_ms":128.0,
  "ewma_throughput_bps":1234567,
  "top8_count":7,
  "consecutive_eligible":5,
  "consecutive_failures":0
}
```

No hostname, token, Worker base URL, Access secret, or other runtime credential is stored.

## 8. Initial EWMA, normalized stability, and confidence calibration

Initial shadow values from the first multi-week measurement analysis:

```text
EWMA_HALF_LIFE_HOURS=36
MAX_HISTORY_WEIGHT=0.30
V2_HYSTERESIS_THRESHOLD=0.15
FAILED_CANARY_COOLDOWN_HOURS=24
FAILED_CANARY_MIN_NEW_CYCLES=4
```

### 8.1 Deterministic EWMA update contract

EWMA state MUST be reproducible from retained detailed run summaries without depending on wall-clock rebuild time, iteration order, or implementation-specific probe processing.

#### Ordered source records

Only persisted run records containing a completed candidate-measurement summary are EWMA inputs. Runs such as `remote_state_unknown` that contain no candidate summaries do not update candidate EWMAs.

For rebuild, process run records in ascending:

```text
(started_at, run_id)
```

where `started_at` is the persisted run timestamp already written by Stage B and `run_id` is the deterministic secondary tie-breaker. Rebuild MUST NOT use filesystem mtime or the time of reconstruction.

#### One update per candidate per completed run

For each candidate summary in a run, derive exactly one cycle-level observation from the existing Stage B summary fields:

```text
reliability_input = successes / rounds
                   = persisted candidate reliability

ttfb_input        = persisted medianTtfbMs of successful probes

total_input       = persisted p95TotalMs of successful probes

throughput_input  = persisted throughputBps
                   = median successful-probe bytes-per-second
```

Do not update EWMAs once per individual probe. The persisted cycle summary is the canonical update input.

#### Initialization

For each metric independently, the first finite observation initializes:

```text
ewma_metric = first_finite_input
last_metric_update_at = run.started_at
```

No synthetic zero/default is inserted for a metric before its first finite observation.

#### Failure/missing-metric behavior

`reliability_input` is always updated when `rounds > 0`, including a fully failed cycle (`0/3 -> 0`).

If TTFB, total, or throughput is non-finite because the cycle produced no usable successful measurement, that metric is not updated for that run. Its previous EWMA and its own `last_metric_update_at` remain unchanged. Reliability, hard-gate failure counters, consecutive failures, and eligibility evidence still record the failed cycle.

This prevents inventing latency/throughput values while ensuring failures degrade historical reliability.

#### Elapsed time

Each metric computes `elapsed_time` from that metric's own persisted `last_metric_update_at` to the current `run.started_at`.

```text
delta = current_run.started_at - last_metric_update_at
```

Negative/non-monotonic timestamps are invalid evidence and stop history rebuild for that candidate rather than being clamped silently.

The exact same ordered run set MUST therefore rebuild the same EWMA state.

### 8.2 Deterministic stability-score normalization

`stability_score` uses the same bounded percentile-component model and weights as Stage B `scoreCandidates()` rather than blending heterogeneous raw EWMA units.

For each scheduled ranking decision, create a historical comparison cohort from current-cycle-eligible candidates participating in that decision and having all four finite historical EWMA metrics.

Normalize with Stage B-equivalent deterministic percentile semantics:

```text
historical_reliability_component = percentile(ewma_reliability, higher_is_better=true)
historical_ttfb_component        = percentile(ewma_ttfb_ms, higher_is_better=false)
historical_total_component       = percentile(ewma_total_ms, higher_is_better=false)
historical_throughput_component  = percentile(ewma_throughput_bps, higher_is_better=true)
```

Compose:

```text
stability_score =
    0.45 * historical_reliability_component
  + 0.25 * historical_ttfb_component
  + 0.15 * historical_total_component
  + 0.15 * historical_throughput_component
```

Thus both `instant_score` and `stability_score` are in `[0,1]`. Raw milliseconds/bytes-per-second never enter the final blend directly.

If a candidate lacks any required historical metric for that cycle:

```text
historical_weight = 0
final_score = instant_score
```

Young history is not punished to zero.

### 8.3 Historical blending and confidence

```text
historical_weight = MAX_HISTORY_WEIGHT * confidence
final_score = instant_score * (1 - historical_weight)
            + stability_score * historical_weight
```

Initial confidence composition:

```text
cycle_confidence    = min(cycles_seen / 24, 1)
coverage_confidence = min(coverage_hours / 120, 1)
daypart_confidence  = min(dayparts_seen / 4, 1)
confidence          = min(cycle_confidence, coverage_confidence, daypart_confidence)
```

Guidance:

```text
low:    <8 independent cycles OR <24h coverage
medium: >=12 cycles, >=48h, >=3 dayparts
high:   >=24 cycles, >=5 days, all 4 dayparts
mature: >=28 cycles, >=7 days
```

These values remain shadow parameters until the fixed-seed follow-up is reviewed.

## 9. Mandatory measurement cohorts

### 9.1 Shadow experiment cohort

After the current seven-day fixed-seed experiment finishes and v2 shadow progression begins, every shadow cycle measures the union of:

```text
real Stage B current entries
+ configured fixed seeds
+ every shadow_current entry
+ every active shadow canary/promoted-observation entry
+ every shadow pre_canary_baseline entry while pinned
+ ordinary Stage B/random exploration candidates
```

### 9.2 Production experiment cohort

Once v2 is activated for real publication, every production experiment cycle additionally and mandatorily measures:

```text
real authoritative current entries
+ every active production canary/recovery-canary/promoted-observation entry
+ every currently pinned authoritative pre-canary baseline entry
+ fixed seeds / normal exploration required by the active sampler
```

The `authoritative_activation_baseline`, and any later authoritative baseline established by a fully graduated production experiment, stays in this mandatory production cohort from canary entry until the corresponding experiment graduates or is explicitly terminated.

A baseline-only address removed from current ADD MUST continue to receive current-cycle probes. It cannot depend on chance exploration, because restore eligibility requires current evidence.

Deduplication and Cloudflare-CIDR validation still apply.

### 9.3 No stale-evidence progression

If any current/canary/promoted/baseline entry required by the active shadow or production transition lacks the current cycle's three-probe evidence:

```text
decision = hold / measurement_incomplete
```

The implementation MUST NOT reuse stale health, mark unsampled entries artificially ineligible, advance canary age, graduate, or restore from incomplete evidence.

### 9.4 Current fixed-seed window remains frozen

These v2 cohort augmentations are NOT enabled during the ongoing seven-day calibration experiment. They start only after that experiment is reviewed or a deliberate new measurement baseline begins.

## 10. Independent shadow lineage

For every scheduled shadow cycle:

1. Stage B computes its normal real selection.
2. shadow measurement completeness gates run.
3. v2 evaluates against `shadow_current`, not real Stage B current after divergence.
4. v2 computes one hypothetical transition.
5. transition state is atomically persisted.
6. real Worker/ADD authority remains untouched.

```text
real Stage B: P100 -> P101 -> P102
v2 shadow:   S100 -> S101(canary) -> S102(promoted observation)
```

Shadow revision IDs are local only and are never sent to Worker authority.

## 11. Challenger maturity and healthy-pool hysteresis

A normal challenger must have current eligibility, more than one independent observation cycle, no recent repeated-failure streak, sufficient confidence for its stage, required `/24` diversity, and acceptable pool-level quality.

### 11.1 Healthy-pool hysteresis gate

When the current pool is healthy, compute current/proposed pool medians from `final_score` values produced in the same current-cycle ranking cohort:

```text
improvement = (proposed_median_final_score - current_median_final_score)
              / current_median_final_score
```

Normal canary entry requires:

```text
improvement >= V2_HYSTERESIS_THRESHOLD
```

Initial threshold is 0.15. Invalid/non-positive current median causes hold, not automatic promotion.

Only explicit unhealthy recovery is exempt from this improvement threshold.

### 11.2 Deterministic failed-canary retry suppression

Every canary or recovery-canary failure persists a non-secret failure record keyed by the canonical proposed-pool fingerprint:

```json
{
  "fingerprint":"...",
  "failed_at":"...",
  "failure_reason":"measurement|hard_gate|client_sanity|post_publish_verification",
  "newcomers":["..."],
  "newcomer_cycles_at_failure":{"...":12},
  "operator_retry_required":false
}
```

A fresh scheduled cycle by itself is NOT material evidence and MUST NOT restart the identical failed fingerprint.

For measurement/hard-gate failures, automatic retry of the same fingerprint is permitted only when all are true:

1. at least `FAILED_CANARY_COOLDOWN_HOURS` (initially 24h) elapsed since `failed_at`;
2. every newcomer accumulated at least `FAILED_CANARY_MIN_NEW_CYCLES` (initially 4) independent completed post-failure cycles;
3. every selected entry passes current hard gates;
4. the proposal still satisfies diversity/pool quality and, for a healthy current pool, the 15% hysteresis gate;
5. no disqualifying repeated-failure streak exists.

For `client_sanity` or `post_publish_verification` failure, identical-fingerprint automatic retry is disabled even after cooldown. It requires either:

- an explicit operator retry acknowledgement persisted as non-secret state; or
- a changed proposed-pool fingerprint that independently passes all gates.

After successful graduation, stale failed-fingerprint records may be pruned under bounded retention.

## 12. Hybrid canary retained-entry rules

Nominal healthy canary:

```text
6 currently eligible retained entries
+ 2 currently eligible mature challengers
= 8
```

Failing old entries are never retained for overlap.

- `>=6` eligible retained: use up to 6 retained + up to 2 challengers.
- exactly 5: guarded `5 + up to 3` only when every challenger is fully qualified and pool gates pass; otherwise hold.
- exactly 4: do not auto-create a normal `4+4`; hold unless unhealthy-recovery criteria are explicitly met.
- `<4`: current pool is unhealthy and enters section 13 recovery flow.

## 13. Every newcomer is canaried, including unhealthy recovery

A normal promoted pool MUST NOT contain a newcomer absent from the immediately preceding observed canary wave. Additional newcomers require additional waves.

```text
baseline: A B C D E F G H
wave 1:   A B C D E F X Y
observe
wave 2:   A B C D X Y Z W
observe
promote:  A B C D X Y Z W
```

### 13.1 Unhealthy recovery is a recovery-canary, not instant graduation

When the current pool is unhealthy (for example fewer than four eligible incumbents), the optimizer may bypass the normal 15% improvement requirement because availability recovery is more important than optimizing a healthy pool.

It MUST NOT bypass the canary state machine.

Recovery sequence:

1. measure all still-eligible incumbents and replacement candidates;
2. build the safest currently eligible/diverse recovery pool from eligible incumbents plus replacements;
3. every replacement must pass current hard gates; historical confidence may be lower than normal challenger maturity only when necessary to restore a minimally viable pool, and that reduced-confidence reason must be recorded;
4. publish/simulate it explicitly as `recovery_canary`, not as a graduated baseline;
5. keep the prior authoritative restore point pinned and measured when it remains restorable;
6. require at least one subsequent scheduled observation cycle with complete current measurements and, in production, client sanity verification;
7. only after observation/identity/hard-gate checks may the recovery-canary progress to promoted observation and eventual graduation.

If recovery-canary fails, revalidate the pinned baseline; if the baseline is degraded, remain in recovery/hold and construct another explicitly identified recovery-canary. Never relabel an unobserved replacement pool as last-known-good.

## 14. Pin restore points and hand off authority safely

### 14.1 Shadow pre-canary baseline

Before leaving a stable shadow baseline for canary wave 1:

```text
pre_canary_baseline = last-known-good shadow pool
```

It stays pinned/measured through all waves and promoted observation until shadow graduation or explicit experiment termination.

### 14.2 Shadow-to-production authority handoff

Before the first real v2 canary mutation:

1. read current Worker-authoritative revision and canonical entries;
2. derive canonical fingerprint;
3. pin exactly that real state as `authoritative_activation_baseline`;
4. immediately include every entry in the production mandatory measurement cohort from section 9.2;
5. require current-cycle evidence and hard gates for the baseline;
6. build the first real canary from real authoritative current + qualified challengers;
7. publish only with expected-current-revision CAS;
8. if authority changes before CAS, abort and restart from fresh authoritative read.

Shadow revisions/baselines are never valid production restore targets.

After a production experiment fully graduates, the exact graduated real pool may become the next authoritative baseline. That new baseline is likewise pinned and mandatorily measured throughout the next production experiment.

## 15. Baseline restore must be revalidated

A pinned baseline is prior-good evidence, not unconditional permission to republish it.

Before any restore, every baseline entry MUST have current-cycle measurements and pass hard gates.

Production restore may CAS-publish only the real pinned authoritative baseline applicable to that experiment, and only when:

- every baseline entry is currently eligible;
- current authoritative revision equals the expected failed experiment revision;
- baseline fingerprint equals the pinned fingerprint.

If any baseline entry fails or lacks measurements:

```text
restore_blocked_baseline_degraded
```

Then hold/measure or enter the explicit recovery-canary flow. Do not silently replace baseline members and call it restoration.

## 16. Canary observation and promotion

A normal or recovery canary becomes eligible for its next transition only after:

- at least one subsequent scheduled cycle;
- complete current measurements for all relevant current/canary/baseline entries;
- all selected entries remain current-cycle eligible;
- pool health/diversity remain acceptable;
- current revision + canonical fingerprint still match the expected experiment state;
- real rollout passes client sanity where applicable;
- failed-canary retry suppression does not prohibit the transition.

Any failure causes hold, baseline restore attempt after revalidation, or a new explicit recovery-canary as applicable.

## 17. Promoted observation and graduation

Promotion does not immediately establish a new last-known-good baseline.

Persist a `promoted_experiment` containing revision, fingerprint, entries, promotion timestamp, and origin (`normal_canary` or `recovery_canary`).

During post-promotion observation, the applicable pre-canary baseline remains pinned and measured.

Before graduation:

1. current shadow/authoritative revision equals promoted experiment revision;
2. current canonical pool fingerprint equals promoted experiment fingerprint;
3. current entries equal the observed promoted pool;
4. required post-promotion observations, hard gates, and client sanity pass.

Any revision/pool mismatch causes hold without clearing the restore point. Only a matching fully observed real promoted experiment may replace the authoritative baseline.

## 18. Transition contract

At minimum:

```text
baseline_hold
baseline_to_canary_wave
canary_wave_hold
canary_wave_to_next_wave
canary_wave_to_promoted_observation
canary_restore_baseline
recovery_canary_start
recovery_canary_hold
recovery_canary_to_promoted_observation
restore_blocked_baseline_degraded
promoted_hold_observation
promoted_graduate
promoted_restore_baseline
measurement_incomplete_hold
revision_or_pool_mismatch_hold
hysteresis_below_threshold_hold
failed_canary_retry_suppressed_hold
```

Every transition records prior/resulting revision, phase, selected entries/fingerprint, wave number, pinned baseline identity, promoted experiment identity, hysteresis metrics when applicable, failed-canary fingerprint state when applicable, reason code, current health summary, Stage-B/v2 overlap, and no secrets.

Impossible transitions fail closed and never silently overwrite authority.

## 19. Failure behavior

- Candidate-history corruption: rebuild from detailed runs; do not publish from corrupt history.
- EWMA rebuild has invalid/non-monotonic evidence: stop affected historical progression; do not guess timestamps or values.
- Shadow-state corruption: stop/reset shadow progression; Stage B measurement continues.
- Required current/canary/baseline entry lacks current probes: `measurement_incomplete_hold`.
- Current hard-gate failure: ineligible regardless of reputation.
- Historical metrics incomplete: historical weight zero; do not blend incompatible units.
- Healthy improvement below threshold: hold.
- Identical failed canary lacks deterministic retry evidence: suppress retry.
- Shadow lineage mismatch: hold; never silently rebase to Stage B.
- Canary/recovery-canary failure: revalidate pinned baseline before restore.
- Pinned baseline degraded: no stale restore; hold or recovery-canary.
- Graduation identity mismatch: hold and preserve baseline.
- Shadow-to-production authority mismatch: abort activation and reread authority.
- Real revision conflict: fail closed; do not retry-overwrite.
- NAS state loss: remote-state reconciliation remains future hardening; do not guess authority.

## 20. Adaptive sampling remains later

A later sampler may target roughly 70–80% exploitation and 20–30% full-range exploration, but adaptive sampling is not enabled during the current fixed-seed experiment. Sampling decides what to measure; it never overrides eligibility or authorizes publication.

## 21. Data retention

Detailed runs remain retained for 30 days and compact history for 180 days initially. Candidate/shadow/failed-canary state remains bounded. No unbounded per-probe store is introduced.

## 22. TDD / evidence plan

Implementation order:

1. deterministic EWMA source-order/input/initialization/missing-metric tests;
2. rebuild-equivalence tests from the same retained run summaries;
3. history aggregation and confidence tests;
4. historical normalization tests proving `[0,1]` bounded scores and Stage B-equivalent percentile semantics;
5. final-score blending tests proving max historical weight is a real cap;
6. hard-gate precedence tests;
7. healthy hysteresis tests including 15% threshold;
8. failed-canary suppression tests: cooldown, minimum new cycles, operator-required retry for client-sanity/post-publish failure;
9. shadow-lineage persistence tests;
10. shadow measurement-cohort union including pinned baseline;
11. production measurement-cohort union including authoritative baseline through graduation;
12. incomplete-measurement hold tests;
13. retained-count fallback tests (`6+2`, guarded `5+3`, no normal `4+4`);
14. normal one-wave/multi-wave newcomer canary tests;
15. recovery-canary tests proving unhealthy recovery cannot directly graduate unobserved replacements;
16. baseline pinning/revalidation/degraded-restore tests;
17. promoted revision/pool identity checks before graduation;
18. shadow-to-production handoff tests proving fresh real authoritative baseline pinning;
19. CAS conflict tests;
20. bounded persistence/corruption tests;
21. NAS Docker validation.

No production publication changes until shadow evidence is reviewed.

## 23. Acceptance gates before v2 controls publication

- Stage B remains authoritative during shadow collection.
- Current seven-day fixed-seed experiment remains unchanged.
- EWMA reconstruction from the same ordered run summaries is deterministic.
- EWMA uses one cycle-level update per persisted candidate summary; failure/missing metric behavior is frozen.
- Shadow and production restore baselines are mandatorily measured throughout their experiment lifetime.
- Missing current measurements cause hold, never stale reuse.
- `instant_score` and `stability_score` are deterministic `[0,1]`; raw units are never blended.
- Candidates lacking complete historical metrics fall back to instant scoring.
- max historical weight is demonstrably bounded.
- healthy normal canary requires explicit hysteresis; unhealthy recovery is exempt only from improvement threshold, not canary observation.
- identical failed canaries cannot churn via immediate retries.
- retained entries and challengers pass current hard gates.
- every normal newcomer appears in an observed canary wave.
- every unhealthy-recovery newcomer appears in an explicit recovery-canary before graduation.
- pinned baselines are revalidated before restore.
- production activation freshly pins and continuously measures the real authoritative baseline.
- no shadow restore point can become production restore target.
- graduation verifies revision and fingerprint identity.
- eventual real mutations remain CAS protected.
- no new secrets are persisted.
- CPU, memory, and disk growth remain bounded.

## 24. Calibration decisions still empirical

Initial values:

```text
EWMA_HALF_LIFE_HOURS=36
MAX_HISTORY_WEIGHT=0.30
V2_HYSTERESIS_THRESHOLD=0.15
FAILED_CANARY_COOLDOWN_HOURS=24
FAILED_CANARY_MIN_NEW_CYCLES=4
```

Still empirical until follow-up data is reviewed:

- 36h versus nearby EWMA half-lives;
- confidence thresholds;
- canary/recovery-canary observation duration beyond the minimum subsequent cycle;
- guarded `5+3` behavior;
- challengers per wave;
- 15% versus nearby hysteresis thresholds;
- failed-canary cooldown/new-evidence thresholds;
- adaptive sampling ratio.

Empirical values may change. Safety invariants do not: deterministic EWMA rebuild, normalized bounded blending, explicit healthy hysteresis, deterministic retry suppression, complete restore-path measurement, observed recovery-canaries, and fresh authoritative baseline pinning are mandatory.
