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
4. every shadow-current entry used for a decision must have current-cycle measurement evidence;
5. every newcomer must pass through an observed canary before it can appear in a promoted pool;
6. a pre-canary restore point stays pinned until the experiment is explicitly graduated;
7. restoring a baseline is permitted only if that baseline is still currently safe;
8. graduation is allowed only while the observed promoted revision/pool is still exactly the one under experiment;
9. `instant_score` and `stability_score` are deterministic bounded scores on the same `[0,1]` scale before blending;
10. a healthy pool is not replaced for a marginal ranking change: explicit v2 hysteresis gates every normal canary transition;
11. shadow revisions and restore points are evidence only; production activation starts by pinning the real authoritative pool that will actually be replaced.

## 2. Goals

- Use recent historical NAS measurements to distinguish stable candidates from one-cycle winners.
- Use time-aware EWMA with bounded historical influence.
- Represent confidence/sample maturity explicitly.
- Keep current hard health gates separate from historical ranking.
- Maintain an independent v2 shadow revision lineage after divergence from Stage B.
- Add configuration-level hybrid canaries before substantial pool replacement.
- Support multiple canary waves when more newcomers are desired than one safe wave allows.
- Persist deterministic, non-secret evidence for each hypothetical transition.
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

Score from the current cycle only. It uses the existing Stage B bounded percentile-component score.

### Stability score

Historical quality derived from EWMA reliability, TTFB, total-time, and throughput, normalized into the same bounded `[0,1]` scoring model as the instant score before blending. Failure/eligibility evidence also affects hard gates, maturity, and confidence, but raw milliseconds or bytes/second are never added directly to the blended score.

### Confidence

How much independent temporal evidence exists. Confidence changes how much history is trusted; it is not an additive quality bonus.

### EWMA

Time-aware exponentially weighted moving average:

```text
decay = exp(-ln(2) * elapsed_time / half_life)
EWMA_new = decay * EWMA_old + (1 - decay) * measurement
```

### Hysteresis

A minimum material pool-level improvement required before a healthy current pool may enter a normal canary. It prevents small score reorderings from causing repeated pool churn.

### Shadow mode

A non-authoritative simulation where v2 performs the state transitions it would perform if it controlled ADD, while real Stage B/Worker authority remains unchanged.

### Shadow revision lineage

The hypothetical ancestry of v2 pools (`shadow_current`, `shadow_previous`, canary revision, promotion revision), independent from real Stage B revisions.

### Pre-canary baseline

The pinned last-known-good pool from immediately before a canary experiment. It is the experiment's restore point, not simply the moving `previous` revision. In shadow mode it is hypothetical; on production activation a new restore point must be pinned from real Worker authority.

### Canary wave

One observed hybrid step introducing a bounded set of newcomers. A later wave may introduce additional newcomers only after the prior wave has been observed/proven.

### Authoritative activation baseline

The real Worker-authoritative revision, canonical entries, and fingerprint read and pinned immediately before v2's first production canary mutation. It is never copied from the shadow lineage.

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
  "phase": "baseline|canary|promoted_observation|graduated|restore_blocked",
  "shadow_current": {"revision":"shadow-...","entries":[],"fingerprint":"..."},
  "shadow_previous": null,
  "shadow_canary": null,
  "promoted_experiment": null,
  "pre_canary_baseline": null,
  "canary_wave": 0,
  "updated_at":"...",
  "reason":"..."
}
```

Fingerprints are deterministic hashes of canonicalized selected entries and are used to verify that the pool being observed is the same pool later promoted/graduated/restored.

A future production-mode state may additionally persist an `authoritative_activation_baseline`, but that object MUST be initialized from a fresh authoritative read during the activation handoff in section 14.1. A shadow revision or shadow baseline must never be re-labeled as authoritative state.

## 6. Current hard eligibility always wins

A candidate first passes current-cycle hard gates, including at minimum:

- at least 2 successful probes out of 3;
- median TTFB inside the configured bound;
- valid TLS/probe contract;
- allowed Cloudflare CIDR;
- no disqualifying current-cycle error pattern.

Only current-cycle-eligible candidates may participate in ranking, retention, canary, promotion, restore, or unhealthy recovery.

Example:

```text
excellent 7-day history + current 0/3 = INELIGIBLE
```

This applies equally to challengers, current Stage B winners, shadow incumbents, and members of a pinned baseline.

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

The first multi-week operator measurement window was analyzed in aggregate in the separate calibration report. Initial shadow values:

```text
EWMA_HALF_LIFE_HOURS=36
MAX_HISTORY_WEIGHT=0.30
V2_HYSTERESIS_THRESHOLD=0.15
```

### 8.1 Deterministic stability-score normalization

`stability_score` MUST use the same bounded percentile-component model and weights as existing Stage B `scoreCandidates()` rather than blending heterogeneous raw EWMA units.

For each scheduled cycle, after current hard eligibility is known, define one historical comparison cohort from the current-cycle-eligible candidates participating in that ranking decision and having all four finite historical EWMA metrics.

Normalize the historical values with the same deterministic percentile semantics used by Stage B:

```text
historical_reliability_component = percentile(ewma_reliability, higher_is_better=true)
historical_ttfb_component        = percentile(ewma_ttfb_ms, higher_is_better=false)
historical_total_component       = percentile(ewma_total_ms, higher_is_better=false)
historical_throughput_component  = percentile(ewma_throughput_bps, higher_is_better=true)
```

Each component is bounded to `[0,1]`, including deterministic tie/singleton behavior matching Stage B. Compose:

```text
stability_score =
    0.45 * historical_reliability_component
  + 0.25 * historical_ttfb_component
  + 0.15 * historical_total_component
  + 0.15 * historical_throughput_component
```

Therefore:

```text
instant_score   in [0,1]
stability_score in [0,1]
```

Raw milliseconds, raw bytes/second, failure counts, or other unbounded values MUST NOT be inserted directly into the final blend.

If a candidate lacks any required historical metric, its historical contribution for that cycle is disabled:

```text
historical_weight = 0
final_score = instant_score
```

It is not penalized to zero merely for being young. Repeated failures continue to affect hard eligibility, challenger maturity, and confidence separately.

### 8.2 Historical blending

```text
historical_weight = MAX_HISTORY_WEIGHT * confidence
final_score = instant_score * (1 - historical_weight)
            + stability_score * historical_weight
```

Because both component scores are bounded identically, `MAX_HISTORY_WEIGHT=0.30` means historical ranking influence is actually capped at 30% for fully confident candidates.

Initial maturity guidance:

```text
low:    <8 independent cycles OR <24h coverage
medium: >=12 cycles, >=48h, >=3 dayparts
high:   >=24 cycles, >=5 days, all 4 dayparts
mature: >=28 cycles, >=7 days
```

Conservative confidence composition:

```text
cycle_confidence    = min(cycles_seen / 24, 1)
coverage_confidence = min(coverage_hours / 120, 1)
daypart_confidence  = min(dayparts_seen / 4, 1)
confidence          = min(cycle_confidence, coverage_confidence, daypart_confidence)
```

These remain shadow parameters until the fixed-seed follow-up window is reviewed.

## 9. Shadow measurement cohort requirement

Once the current seven-day fixed-seed experiment finishes and v2 shadow progression begins, the measurement cohort MUST explicitly retain every address needed to evaluate the shadow state and its restore path.

Per cycle, the candidate set must include the union of:

```text
real Stage B current entries
+ configured fixed seeds
+ every shadow_current entry
+ every active canary/promoted-observation entry
+ every pre_canary_baseline entry while that baseline is pinned
+ ordinary Stage B/random exploration candidates
```

Deduplication and Cloudflare-CIDR validation still apply.

Pinned-baseline membership is mandatory for the entire experiment lifetime from canary entry until graduation or explicit experiment termination. A baseline-only address that was removed from `shadow_current` must continue to be scheduled so restore safety can be evaluated from current evidence rather than chance exploration.

### 9.1 No stale-evidence progression

A shadow transition that depends on an incumbent or restore point requires that entry to have the current cycle's three-probe evidence.

If any required `shadow_current`, active canary, promoted-observation, or pinned-baseline member lacks current-cycle measurements:

```text
shadow decision = hold / measurement_incomplete
```

The implementation MUST NOT:

- reuse stale prior-cycle health as current eligibility;
- mark the missing entry ineligible merely because it was not sampled;
- advance canary age/promotion/graduation based on incomplete measurement;
- attempt restoration while any pinned-baseline entry lacks current-cycle evidence.

### 9.2 Current fixed-seed window remains frozen

This cohort augmentation is NOT enabled during the ongoing seven-day calibration experiment. Shadow lineage progression starts only after that experiment is reviewed or when a deliberately new measurement baseline begins.

## 10. Independent shadow lineage

For every scheduled shadow cycle:

1. Stage B computes its normal real selection.
2. The measurement completeness gate in section 9 runs.
3. v2 evaluates measurements/history against `shadow_current`, not real Stage B current after divergence.
4. v2 computes one hypothetical transition.
5. The transition atomically updates `v2-shadow-state.json`.
6. Real Worker/ADD authority remains untouched.

Example:

```text
real Stage B: P100 -> P101 -> P102
v2 shadow:   S100 -> S101(canary) -> S102(promoted observation)
```

Shadow revision IDs are local only and are never sent to Worker authority.

## 11. Challenger maturity and explicit hysteresis

A normal challenger must have:

- current-cycle eligibility;
- more than one independent observation cycle unless using the separate unhealthy-recovery path;
- no recent repeated-failure streak;
- sufficient confidence for the promotion stage;
- required `/24` diversity and pool-level quality.

Emergency unhealthy recovery remains possible, but no historical reputation can override a current hard-gate failure.

### 11.1 Healthy-pool hysteresis gate

When `shadow_current` is healthy, v2 MUST NOT enter a normal canary merely because a proposed pool sorts slightly higher.

Compute the current and proposed pool medians from `final_score` values produced in the same current-cycle ranking cohort:

```text
improvement = (proposed_median_final_score - current_median_final_score)
              / current_median_final_score
```

For initial shadow calibration:

```text
V2_HYSTERESIS_THRESHOLD=0.15
```

A healthy baseline may transition to a canary only when:

```text
improvement >= V2_HYSTERESIS_THRESHOLD
```

If the current median is invalid/non-positive, hold rather than treating that as an automatic normal promotion.

The explicit unhealthy-recovery path is exempt from this improvement threshold because its purpose is recovery from a failed/unhealthy current pool, not optimization of an already healthy one.

The same proposed fingerprint must not repeatedly restart an equivalent canary without new material evidence after a hold/failed experiment.

## 12. Hybrid canary retained-entry rules

Nominal canary:

```text
6 currently eligible retained entries
+ 2 currently eligible mature challengers
= 8
```

Failing old entries are never retained just for overlap.

### >=6 eligible retained

Use up to six best eligible incumbents plus up to two fully qualified challengers.

### exactly 5 eligible retained

A guarded `5 + up to 3` canary MAY be used only when every challenger is fully qualified and pool-level gates pass. Otherwise hold.

### exactly 4 eligible retained

Do not auto-create a normal `4+4` canary. Hold unless the separate unhealthy-recovery path is explicitly invoked.

### <4 eligible retained

Treat the pool as unhealthy and enter the recovery path. Every replacement still must pass current hard gates.

## 13. Every newcomer must be canaried before promotion

A full promoted pool MUST NOT contain a newcomer that was absent from the observed canary pool immediately preceding that promotion.

Example of an invalid transition:

```text
baseline: A B C D E F G H
canary:   A B C D E F X Y
promoted: A B C D X Y Z W   <-- INVALID: Z/W were never canaried
```

Valid alternatives:

### Option A — promote only observed newcomers

```text
baseline: A B C D E F G H
wave 1:   A B C D E F X Y
promote:  A B C D E F X Y
```

### Option B — multiple canary waves

```text
baseline: A B C D E F G H
wave 1:   A B C D E F X Y
observe wave 1
wave 2:   A B C D X Y Z W
observe wave 2
promote:  A B C D X Y Z W
```

Every address newly introduced by a wave must remain current-cycle eligible through that wave's observation gate.

The pinned pre-canary baseline remains the original baseline across all waves until explicit graduation.

## 14. Pin the pre-canary baseline

Before leaving a stable shadow baseline for canary wave 1, pin:

```text
pre_canary_baseline = last-known-good shadow pool
```

It does not advance merely because `shadow_previous` changes, another canary wave occurs, or a promoted pool begins observation.

This is the optimizer's restore point inside the hypothetical shadow world only.

### 14.1 Shadow-to-production authority handoff

Shadow success does not authorize copying the shadow restore point into production. Before the first real v2 canary mutation, perform a fresh authoritative handoff:

1. read the current Worker-authoritative revision and canonical pool entries;
2. derive and persist their canonical fingerprint;
3. pin exactly that real state as `authoritative_activation_baseline`;
4. require current-cycle measurements for every authoritative baseline entry and apply the same hard gates;
5. build the first real canary from the real authoritative current pool plus qualified v2 challengers;
6. publish only with expected-current-revision CAS against the authoritative revision read in step 1;
7. if the authoritative revision/pool changes before the CAS publish, abort activation, discard the stale handoff attempt, and start again from a fresh authoritative read.

The implementation MUST NOT:

- copy a `shadow-*` revision into Worker authority;
- use `pre_canary_baseline` from the shadow lineage as the production restore point;
- assume the real current pool equals `shadow_current` merely because shadow evaluation was successful;
- clear the real baseline until the corresponding production experiment graduates under the same identity gates.

Shadow history, confidence, and rankings may inform challenger choice, but the first real production restore point is always the pool that was actually serving immediately before v2's first real mutation.

## 15. Baseline restore must be revalidated

A pinned baseline is historical evidence of prior goodness, not unconditional permission to republish it later.

Before any restore transition, every baseline entry MUST have current-cycle measurement evidence and pass the hard gates in section 6.

### 15.1 Entire baseline still eligible

Shadow mode may restore its exact shadow baseline inside the simulation.

Production mode may CAS-publish only the real pinned `authoritative_activation_baseline` (or the later production baseline established by a fully graduated production experiment), and only when:

- every real baseline entry is currently eligible;
- current authoritative revision matches the expected failed experiment revision;
- the real baseline fingerprint matches the pinned authoritative fingerprint.

A hypothetical shadow baseline is never a valid production restore target.

### 15.2 Any baseline member currently fails or lacks measurements

Do NOT restore the stale snapshot verbatim.

Transition to:

```text
restore_blocked_baseline_degraded
```

Then either:

- hold/no-publish while collecting complete measurements; or
- enter the gated unhealthy-recovery path to construct a new currently eligible safe pool.

The system MUST NOT silently replace failing baseline members and still call the result a restoration of the pinned baseline. That is a new recovery decision with its own evidence and revision.

## 16. Canary observation and promotion

A canary wave becomes eligible for the next transition only after:

- at least one subsequent scheduled cycle;
- all entries whose status matters to the transition have current-cycle measurements;
- all selected entries remain current-cycle eligible;
- pool-level health/diversity remain acceptable;
- the observed shadow/current revision and pool fingerprint still match the expected canary wave;
- eventual initial real rollout also includes a client sanity check.

If any of those conditions fail, hold or restore/recover according to sections 15 and 19.

## 17. Promoted observation and graduation

Promotion does not immediately establish a new last-known-good baseline.

When a canary has passed, create a `promoted_experiment` record containing at minimum:

```json
{
  "revision":"shadow-... or real revision",
  "fingerprint":"...",
  "entries":[],
  "promoted_at":"..."
}
```

During post-promotion observation, the applicable pre-canary baseline stays pinned.

### 17.1 Graduation identity gate

Before graduation may clear/replace the pinned baseline, verify:

1. current shadow/authoritative revision equals `promoted_experiment.revision`;
2. current canonical pool fingerprint equals `promoted_experiment.fingerprint`;
3. current entries are the same observed promoted pool;
4. all required post-promotion observations and hard gates pass.

If another authorized mutation, recovery, or manual operation changed revision or pool:

```text
graduation = hold / revision_or_pool_mismatch
```

Do NOT clear the applicable pinned baseline and do NOT declare the unobserved replacement last-known-good.

Only a matching, fully observed promoted experiment may graduate. In production, graduation may replace the real authoritative restore point only with the exact real promoted pool that passed these gates.

## 18. Shadow transition contract

At minimum:

```text
baseline_hold
baseline_to_canary_wave
canary_wave_hold
canary_wave_to_next_wave
canary_wave_to_promoted_observation
canary_restore_baseline
restore_blocked_baseline_degraded
promoted_hold_observation
promoted_graduate
promoted_restore_baseline
unhealthy_recovery
measurement_incomplete_hold
revision_or_pool_mismatch_hold
hysteresis_below_threshold_hold
```

Every transition records:

- prior and resulting shadow revision;
- phase;
- selected entries/fingerprint;
- canary wave number;
- pinned baseline revision/fingerprint;
- promoted experiment revision/fingerprint when present;
- current/proposed median final scores and improvement when hysteresis applies;
- reason code;
- current pool health summary;
- Stage B-v2 overlap;
- no secrets.

Impossible transitions fail closed in shadow state and never affect Stage B measurement.

## 19. Failure behavior

- Candidate-history corruption: rebuild from detailed runs; do not publish from corrupt history.
- Shadow-state corruption: stop/reset shadow progression; Stage B measurement continues.
- Required shadow/current/baseline entry lacks current-cycle probes: `measurement_incomplete_hold`.
- Current hard-gate failure: candidate ineligible regardless of history/incumbent/baseline status.
- Historical metrics incomplete: historical weight becomes zero for that candidate; do not blend raw or incompatible units.
- Healthy pool improvement below hysteresis threshold: hold; do not open/restart a normal canary.
- Shadow lineage mismatch: hold; never silently rebase to real Stage B.
- Canary/newcomer fails: attempt baseline restore only after baseline revalidation.
- Pinned baseline degraded: do not restore stale baseline; hold or unhealthy recovery.
- Graduation revision/pool mismatch: hold and preserve baseline.
- Shadow-to-production handoff revision/pool mismatch: abort activation and repeat the authoritative read; never publish from stale handoff state.
- Real revision conflict after eventual activation: fail closed; do not retry-overwrite.
- NAS state loss: remote-state reconciliation remains future hardening; do not guess authority.

## 20. Adaptive sampling remains later

The prior multi-week window showed prefix productivity is strongly non-uniform, so a later shadow sampler may target roughly:

```text
70–80% exploitation
20–30% full-range exploration
```

But adaptive sampling is not enabled during the current fixed-seed experiment. When later implemented, sampling decides what to measure; it never overrides eligibility or authorizes publication.

## 21. Data retention

Detailed runs remain retained for 30 days and compact history for 180 days initially. Derived candidate and shadow state remain bounded. No unbounded per-probe append-only store is introduced.

## 22. TDD / evidence plan

Implementation order:

1. time-aware EWMA tests;
2. history aggregation tests;
3. confidence/maturity tests;
4. historical normalization tests proving all stability components/final `stability_score` stay in `[0,1]` and reuse Stage B percentile semantics;
5. final-score blending tests proving `MAX_HISTORY_WEIGHT` actually caps historical influence;
6. hard-gate precedence tests;
7. explicit v2 hysteresis tests including healthy hold below 15% and unhealthy-recovery exemption;
8. shadow-lineage persistence tests;
9. measurement-cohort union tests proving every shadow-current/canary/promoted/pinned-baseline entry is probed;
10. incomplete-measurement hold tests;
11. retained-count fallback tests (`6+2`, guarded `5+3`, no normal `4+4`);
12. pre-canary baseline pinning tests;
13. one-wave and multi-wave canary tests;
14. test that uncanaried newcomers cannot enter promotion;
15. baseline revalidation tests, including degraded restore blocking;
16. promoted revision/pool identity checks before graduation;
17. shadow-to-production handoff tests proving the real authoritative revision/entries/fingerprint are newly pinned and no shadow revision/baseline can become a production restore point;
18. stale-authority handoff CAS-conflict tests;
19. expected-revision CAS interface tests without enabling production publication;
20. bounded persistence/corruption tests;
21. NAS Docker validation.

No production publication changes until shadow evidence is reviewed.

## 23. Acceptance gates before v2 controls publication

- Stage B remains authoritative during shadow collection.
- Current seven-day fixed-seed experiment remains unchanged.
- After that window, every `shadow_current`/active canary/promoted-observation/pinned-baseline entry receives current-cycle probes before transition decisions.
- Missing current measurements cause hold, never stale reuse or artificial ineligibility.
- `instant_score` and `stability_score` are both deterministic `[0,1]` values; raw EWMA milliseconds/bytes-per-second are never blended directly.
- Candidates lacking complete historical metrics fall back to current instant scoring rather than receiving an arbitrary history penalty.
- `MAX_HISTORY_WEIGHT` is demonstrably an actual upper bound on historical influence.
- v2 maintains its own shadow lineage after divergence.
- Retained entries and challengers both pass current hard gates.
- A healthy pool enters normal canary only after the explicit v2 hysteresis threshold is met; unhealthy recovery is the only exemption.
- Every promoted newcomer has appeared in an observed canary wave.
- `pre_canary_baseline` remains pinned and measured until explicit shadow graduation.
- Restore revalidates every baseline entry; stale/degraded baselines are not republished.
- Shadow-to-production activation freshly pins the real authoritative revision, entries, and fingerprint before the first real canary.
- No shadow revision or shadow restore point can be used as a production restore target.
- Graduation verifies revision and pool fingerprint still match the promoted experiment.
- Confidence cannot rescue bad current performance.
- Decisions are reproducible from persisted evidence.
- Eventual real mutations remain CAS protected.
- No new secrets are persisted.
- CPU, memory, and disk growth remain bounded.

## 24. Calibration decisions still empirical

Initial shadow values:

```text
EWMA_HALF_LIFE_HOURS=36
MAX_HISTORY_WEIGHT=0.30
V2_HYSTERESIS_THRESHOLD=0.15
```

Still empirical until the fixed-seed follow-up is reviewed:

- 36h versus nearby EWMA half-lives;
- confidence thresholds;
- canary wave observation duration;
- guarded `5+3` versus hold behavior;
- number of challengers per canary wave;
- 15% versus nearby hysteresis thresholds;
- adaptive sampler exploration/exploitation ratio.

The exact empirical values may change. The safety invariants do not: normalized bounded blending, explicit nonzero hysteresis for healthy-pool replacement, complete restore-path measurement, and fresh authoritative baseline pinning at production activation are mandatory.
