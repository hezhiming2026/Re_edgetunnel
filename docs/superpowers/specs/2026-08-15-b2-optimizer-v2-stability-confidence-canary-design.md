# B2 Optimizer v2: Historical Stability, Confidence, and Canary Promotion

Date: 2026-08-15
Updated: 2026-08-25
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
6. a pre-canary restore point stays pinned and continuously measured until the experiment is safely graduated or terminally reconciled;
7. restoring a baseline is permitted only if that baseline is still currently safe;
8. graduation is allowed only while the observed promoted revision/pool is still exactly the one under experiment;
9. `instant_score`, `stability_score`, and `confidence` are deterministic from a frozen evidence contract;
10. historical state is reproducible from the same retained canonical 30-day run window;
11. a healthy pool is not replaced for a marginal ranking change: explicit v2 hysteresis gates every normal canary transition;
12. a failed canary cannot immediately restart merely because another scheduled cycle completed;
13. every production experiment starts by freshly pinning the real effective authority actually being replaced;
14. an ungraduated production canary can never become a future baseline merely because an experiment was terminated;
15. unrevisioned manual ADD authority cannot race v2 publication: it interlocks production v2 and prevents mutation/graduation until cleared and re-read.

## 2. Goals

- Use recent historical NAS measurements to distinguish stable candidates from one-cycle winners.
- Use time-aware EWMA with bounded historical influence.
- Represent confidence/sample maturity explicitly and reproducibly.
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
- Making the current unrevisioned manual ADD override revision-addressable; v2 uses an explicit interlock instead.

## 4. Terminology

### Instant score

Score from the current cycle only, using the existing Stage B bounded percentile-component score.

### Stability score

Historical quality derived from EWMA reliability, TTFB, total-time, and throughput, normalized into the same bounded `[0,1]` scoring model as instant score before blending.

### Confidence

How much independent temporal evidence exists. Confidence changes how much history is trusted; it is not an additive quality bonus. Its cycle count, coverage, and daypart inputs are defined deterministically in section 8.3.

### EWMA

Time-aware exponentially weighted moving average:

```text
decay = exp(-ln(2) * elapsed_time / half_life)
EWMA_new = decay * EWMA_old + (1 - decay) * measurement
```

### Canonical history window

The last 30 days of retained detailed completed run evidence strictly before the current ranking cycle. v2 historical scores are derived from this window, not from an unbounded lifetime accumulator.

### Hysteresis

A minimum material pool-level improvement required before a healthy current pool may enter a normal canary.

### Shadow mode

A non-authoritative simulation where v2 performs the state transitions it would perform if it controlled ADD, while real Stage B/Worker authority remains unchanged.

### Shadow revision lineage

The hypothetical ancestry of v2 pools (`shadow_current`, `shadow_previous`, canary revision, promotion revision), independent from real Stage B revisions.

### Pre-canary baseline

The pinned last-known-good pool from immediately before a canary experiment. In shadow mode it is hypothetical; in production it is authoritative state actually served before that specific experiment.

### Production experiment baseline

The freshly read real effective-authority revision, canonical entries, and fingerprint pinned immediately before **each** production canary/recovery-canary experiment. It is never reused blindly from a prior graduated experiment.

### Canary wave

One observed configuration step introducing a bounded set of newcomers. A later wave may introduce additional newcomers only after the prior wave has been observed/proven.

### Recovery canary

The first authoritative recovery configuration used when the current pool is unhealthy. It may bypass the normal healthy-pool improvement threshold, but it remains an ungraduated canary and must pass observation/client-sanity gates before becoming stable.

### Manual-authority interlock

A fail-closed production-v2 state triggered whenever effective ADD is supplied by the current unrevisioned manual override. v2 performs no authoritative mutation, restore, or graduation while the interlock is active.

## 5. Evidence and persisted state

Primary local evidence:

- `/data/runs/*.json` detailed run records retained for 30 days;
- `/data/history.jsonl` compact operational history retained for 180 days but not used as a substitute for detailed scoring inputs;
- `/data/current.json` / `previous.json` for Stage B authority when publication is eventually used.

Derived non-secret files:

```text
/data/candidate-stats.json
/data/v2-shadow-state.json
/data/v2-production-state.json
```

`candidate-stats.json` is a rebuildable cache, not an independent historical authority. Its scoring state MUST equal recomputation from the canonical retained 30-day detailed-run window defined in section 8.1.

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

Production state persists at minimum:

```json
{
  "schema_version": 1,
  "phase": "idle|canary|recovery_canary|promoted_observation|termination_pending|manual_authority_interlock|graduated",
  "experiment_id": null,
  "production_experiment_baseline": null,
  "current_experiment": null,
  "promoted_experiment": null,
  "ungraduated_authority": null,
  "updated_at":"..."
}
```

Fingerprints are deterministic hashes of canonicalized selected entries and verify that the pool being observed is the pool later promoted/graduated/restored.

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

## 8. Initial EWMA, normalized stability, confidence, and retention contract

Initial shadow values:

```text
EWMA_HALF_LIFE_HOURS=36
MAX_HISTORY_WEIGHT=0.30
V2_HYSTERESIS_THRESHOLD=0.15
FAILED_CANARY_COOLDOWN_HOURS=24
FAILED_CANARY_MIN_NEW_CYCLES=4
HISTORY_WINDOW_DAYS=30
```

### 8.1 Canonical 30-day historical evidence window

The authoritative input for v2 historical scoring at ranking cycle `T` is the set of detailed completed run records satisfying:

```text
T - HISTORY_WINDOW_DAYS <= run.started_at < T
```

`T` is the persisted `started_at` of the current ranking cycle. Wall-clock rebuild time, filesystem mtime, and records at or after `T` are never used to decide membership.

Consequences:

- the current cycle contributes only to `instant_score`; it is incorporated into historical state for later cycles, avoiding double-counting current evidence;
- when a detailed run ages beyond 30 days, its contribution intentionally leaves the canonical scoring universe;
- incremental caches MUST be recomputed/evicted so they equal a fresh rebuild from the surviving window;
- corruption recovery rebuilds from the same retained window and therefore produces the same state;
- `history.jsonl` may retain 180 days for operations/reporting but is not used to resurrect pruned detailed scoring evidence.

At the current cycle volume this bounded recomputation is acceptable. An implementation may optimize incrementally only if equivalence to canonical window rebuild is tested.

### 8.2 Deterministic EWMA update contract

Within the canonical window, process qualifying run records in ascending:

```text
(started_at, run_id)
```

Duplicate `(started_at, run_id)` records with identical content are deduplicated. Divergent duplicates are corrupt evidence and fail closed for historical scoring.

Only persisted completed candidate-measurement summaries are inputs. Runs such as `remote_state_unknown` with no candidate summaries do not update candidate history.

For each candidate summary, derive one cycle-level observation:

```text
reliability_input = persisted successes / rounds
                   = persisted candidate reliability

ttfb_input        = persisted medianTtfbMs of successful probes

total_input       = persisted p95TotalMs of successful probes

throughput_input  = persisted throughputBps
                   = median successful-probe bytes-per-second
```

Do not update EWMA once per individual probe.

For each metric independently, the first finite observation initializes:

```text
ewma_metric = first_finite_input
last_metric_update_at = run.started_at
```

`reliability_input` updates whenever `rounds > 0`, including `0/3 -> 0`. If TTFB/total/throughput is non-finite because there was no usable successful measurement, that metric is not updated for that run and its own previous timestamp/value remain unchanged.

Each metric computes elapsed time from its own prior persisted observation timestamp to current `run.started_at`. Negative/non-monotonic evidence fails closed rather than being clamped.

### 8.3 Deterministic confidence aggregation

Confidence uses the same canonical historical window and the same deduplicated qualifying candidate-cycle records as section 8.2.

For one candidate:

```text
cycles_seen = count of distinct completed runs in the window
              that contain that candidate with rounds > 0
```

A 0/3 cycle still counts as an independent observation cycle; quality is handled separately by reliability/hard gates.

```text
first_seen_at = minimum qualifying run.started_at
last_seen_at  = maximum qualifying run.started_at
coverage_hours = max(0, (last_seen_at - first_seen_at) / 1 hour)
```

With zero qualifying cycles, confidence is zero. With exactly one qualifying cycle, `coverage_hours=0`.

`dayparts_seen` uses **UTC** and four fixed six-hour buckets based only on persisted `run.started_at`:

```text
00:00:00-05:59:59 UTC -> bucket 0
06:00:00-11:59:59 UTC -> bucket 1
12:00:00-17:59:59 UTC -> bucket 2
18:00:00-23:59:59 UTC -> bucket 3
```

`dayparts_seen` is the number of distinct buckets represented by qualifying candidate cycles. Host/NAS timezone and DST do not affect it.

Confidence is then exactly:

```text
cycle_confidence    = min(cycles_seen / 24, 1)
coverage_confidence = min(coverage_hours / 120, 1)
daypart_confidence  = min(dayparts_seen / 4, 1)
confidence          = min(cycle_confidence, coverage_confidence, daypart_confidence)
```

Malformed timestamps or divergent duplicate source records invalidate historical confidence for that candidate rather than being guessed.

Guidance remains:

```text
low:    <8 independent cycles OR <24h coverage
medium: >=12 cycles, >=48h, >=3 dayparts
high:   >=24 cycles, >=5 days, all 4 dayparts
mature: >=28 cycles, >=7 days
```

### 8.4 Deterministic stability-score normalization

`stability_score` uses the same bounded percentile-component model and weights as Stage B `scoreCandidates()`.

For each scheduled ranking decision, create a historical comparison cohort from current-cycle-eligible candidates participating in that decision and having all four finite historical EWMA metrics from the canonical window.

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

Both `instant_score` and `stability_score` are in `[0,1]`. Raw milliseconds/bytes-per-second never enter the final blend directly.

If a candidate lacks any required historical metric:

```text
historical_weight = 0
final_score = instant_score
```

### 8.5 Historical blending

```text
historical_weight = MAX_HISTORY_WEIGHT * confidence
final_score = instant_score * (1 - historical_weight)
            + stability_score * historical_weight
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

Once v2 is activated for real publication, every active production experiment cycle mandatorily measures:

```text
real effective authoritative current entries
+ every active production canary/recovery-canary/promoted-observation entry
+ every entry in that experiment's pinned production_experiment_baseline
+ fixed seeds / normal exploration required by the active sampler
```

A baseline-only address removed from current ADD continues to receive current-cycle probes until the experiment graduates or reaches a safely reconciled terminal state under section 15. Mere termination request is not sufficient to drop it from the cohort.

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
4. the proposal still satisfies diversity/pool quality and, for a healthy current pool, hysteresis;
5. no disqualifying repeated-failure streak exists.

For `client_sanity` or `post_publish_verification` failure, identical-fingerprint automatic retry is disabled. It requires explicit operator retry acknowledgement persisted as non-secret state or a changed proposed-pool fingerprint that independently passes all gates.

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

When the current pool is unhealthy, the optimizer may bypass the normal 15% improvement requirement because availability recovery is more important than optimizing a healthy pool. It MUST NOT bypass the canary state machine.

Recovery sequence:

1. measure all still-eligible incumbents and replacement candidates;
2. build the safest currently eligible/diverse recovery pool;
3. every replacement passes current hard gates; lower historical confidence is allowed only when necessary for minimal viability and is recorded;
4. publish/simulate explicitly as `recovery_canary`, never as graduated baseline;
5. keep the experiment baseline pinned/measured when still restorable;
6. require at least one subsequent complete scheduled observation cycle and, in production, client sanity verification;
7. only after observation/identity/hard-gate checks may it progress to promoted observation and graduation.

If recovery-canary fails, revalidate the pinned baseline; if degraded, remain in recovery/hold and construct another explicitly identified recovery-canary. Never relabel an unobserved replacement pool as last-known-good.

## 14. Production authority handoff and manual-authority interlock

### 14.1 Fresh authority pin before every production experiment

The first v2 activation is not special. Before **every** transition from production idle/graduated state into a new normal canary or recovery-canary experiment:

1. read the current effective Worker authority immediately before experiment entry;
2. require effective `add_source` to be the revision-addressable optimizer authority, not unrevisioned manual override;
3. read its current revision and canonical entries and derive canonical fingerprint;
4. create a new `experiment_id` and pin exactly that state as `production_experiment_baseline`;
5. add every baseline entry to the mandatory measurement cohort;
6. require current-cycle measurements/hard gates as applicable;
7. build the experiment from that freshly read real current pool;
8. publish only with expected-current-revision CAS against the revision read for this experiment;
9. if revision, effective source, entries, or fingerprint change before publication verification, abort experiment entry and start over from a fresh read.

A previously graduated pool may happen to equal the new baseline, but equality is proven by this fresh read; it is never assumed or reused solely from old local state.

Shadow revisions/baselines are never valid production restore targets.

### 14.2 Unrevisioned manual ADD interlock

Under the current Stage B authority contract, a manual override can take precedence without participating in the optimizer revision CAS. Therefore v2 production control MUST NOT treat manual effective authority as safely revision-addressable.

Rules:

- if the fresh effective-authority read reports manual override / `add_source=manual`, production v2 experiment entry is blocked with `manual_authority_interlock`;
- v2 performs no publish, restore, graduation, or baseline replacement while manual override is effective;
- immediately before and immediately after any real v2 publish/restore, verification MUST re-read the **effective** ADD source and canonical effective entries, not optimizer revision metadata alone;
- if manual override appears after handoff or races a CAS publish, the v2 mutation is not considered effective/successful; the experiment enters `manual_authority_interlock`, preserves its pinned baseline/provenance, and stops further authoritative mutation;
- clearing manual override does not resume the stale experiment automatically. The operator must explicitly clear/reconcile the interlock, after which section 14.1 performs a new fresh authority read and pins a new experiment baseline;
- an authorized manual takeover is therefore treated as external authority, not as a v2 graduation.

A future design may make manual overrides revision-addressable and integrate them into one effective-authority CAS. Until then, this interlock is mandatory.

## 15. Baseline restore and experiment termination

### 15.1 Baseline restore must be revalidated

A pinned experiment baseline is prior-good evidence, not unconditional permission to republish it.

Before restore, every baseline entry MUST have current-cycle measurements and pass hard gates.

Production restore may CAS-publish only that experiment's freshly pinned real baseline, and only when:

- every baseline entry is currently eligible;
- effective authority is revision-addressable optimizer authority, not manual override;
- current authoritative revision equals the expected failed experiment revision;
- baseline fingerprint equals the pinned fingerprint.

If any baseline entry fails/lacks measurements:

```text
restore_blocked_baseline_degraded
```

Then hold/measure or enter explicit recovery-canary. Do not silently replace baseline members and call it restoration.

### 15.2 Termination cannot legitimize an unobserved pool

An operator request to terminate a production canary/recovery-canary/promoted-observation experiment does **not** clear its baseline, provenance, or mandatory measurement cohort by itself.

A production experiment reaches a terminal state only by one of these paths:

#### A. Safe restore termination

1. revalidate the pinned `production_experiment_baseline`;
2. CAS-restore it against the current expected experiment revision;
3. verify effective ADD source/entries/fingerprint equal the restored baseline;
4. mark `terminated_restored` and then clear experiment state.

#### B. Observed graduation then termination

If the currently serving experimental pool completes all normal observation/graduation gates, it may graduate first; only then may the experiment be terminated as stable.

#### C. Termination blocked / external reconciliation required

If the baseline cannot be safely restored and the current experimental pool is not graduated, persist:

```text
phase = termination_pending
ungraduated_authority = { revision/source/entries/fingerprint/origin }
```

The pinned baseline and required measurement cohort remain active. No new v2 production experiment may begin and the ungraduated pool MUST NOT be admitted as a future `production_experiment_baseline` merely because it is currently serving.

If a manual override takes over during this state, section 14.2 interlock applies. Future v2 activation remains blocked until the operator reconciles authority and either safely restores a known baseline or deliberately runs the serving pool through the required observation/graduation process.

Thus `explicit termination` is an administrative request, not a shortcut around graduation.

## 16. Canary observation and promotion

A normal or recovery canary becomes eligible for its next transition only after:

- at least one subsequent scheduled cycle;
- complete current measurements for all relevant current/canary/baseline entries;
- all selected entries remain current-cycle eligible;
- pool health/diversity remain acceptable;
- current revision + canonical effective pool fingerprint still match expected experiment state;
- effective authority is not under manual-authority interlock;
- real rollout passes client sanity where applicable;
- failed-canary retry suppression does not prohibit the transition.

Any failure causes hold, baseline restore attempt after revalidation, manual-authority interlock, termination_pending, or a new explicit recovery-canary as applicable.

## 17. Promoted observation and graduation

Promotion does not immediately establish a new last-known-good baseline.

Persist a `promoted_experiment` containing experiment ID, revision, fingerprint, entries, promotion timestamp, and origin (`normal_canary` or `recovery_canary`).

During post-promotion observation, that experiment's baseline remains pinned and measured.

Before graduation:

1. current effective source is still revision-addressable optimizer authority;
2. current authoritative revision equals promoted experiment revision;
3. current canonical effective pool fingerprint equals promoted experiment fingerprint;
4. current entries equal the observed promoted pool;
5. required post-promotion observations, hard gates, and client sanity pass;
6. no termination/manual-authority interlock is active.

Any revision/source/pool mismatch causes hold without clearing the baseline. Only a matching fully observed real promoted experiment may graduate.

Graduation does not pre-pin the next experiment. Section 14.1 fresh-reads authority again when the next experiment actually begins.

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
manual_authority_interlock
termination_pending
terminated_restored
```

Every transition records prior/resulting revision, experiment ID, phase, selected entries/fingerprint, wave number, pinned baseline identity, promoted experiment identity, hysteresis metrics when applicable, failed-canary state when applicable, effective authority source, reason code, current health summary, Stage-B/v2 overlap, and no secrets.

Impossible transitions fail closed and never silently overwrite authority.

## 19. Failure behavior

- Candidate-history/cache corruption: rebuild from the canonical retained 30-day detailed-run window; do not publish from corrupt history.
- Cache differs from canonical-window rebuild: discard/rebuild cache before using history.
- Historical evidence has invalid/non-monotonic timestamps or divergent duplicate records: fail closed for affected historical scoring.
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
- Fresh experiment-entry authority mismatch: abort and reread/re-pin authority.
- Manual effective authority: `manual_authority_interlock`; no v2 mutation/graduation.
- Termination request with ungraduated authority: retain provenance/baseline and enter `termination_pending`; never admit the serving pool as stable automatically.
- Real optimizer revision conflict: fail closed; do not retry-overwrite.
- NAS state loss while production experiment active: do not guess authority; publication remains blocked until explicit reconciliation.

## 20. Adaptive sampling remains later

A later sampler may target roughly 70–80% exploitation and 20–30% full-range exploration, but adaptive sampling is not enabled during the current fixed-seed experiment. Sampling decides what to measure; it never overrides eligibility or authorizes publication.

## 21. Data retention

Detailed runs remain retained for 30 days and define the canonical historical scoring window. Compact history remains retained for 180 days for operational/audit summaries only.

`candidate-stats.json` is a bounded cache that MUST be equivalent to rebuild from the current canonical detailed-run window; it cannot preserve scoring influence from pruned runs. Shadow/production/failed-canary state remains bounded and stores state-machine provenance rather than unbounded probe history.

No unbounded per-probe store is introduced.

## 22. TDD / evidence plan

Implementation order:

1. canonical 30-day history-window membership tests using persisted cycle timestamp, not wall clock;
2. deterministic EWMA source-order/input/initialization/missing-metric tests;
3. cache-vs-window rebuild equivalence tests, including pruning a >30-day run and proving its influence is evicted;
4. deterministic confidence tests for `cycles_seen`, coverage endpoints, UTC daypart boundaries, failures, singleton cycles, duplicate/corrupt evidence;
5. historical normalization tests proving `[0,1]` bounded scores and Stage B-equivalent percentile semantics;
6. final-score blending tests proving max historical weight is a real cap;
7. hard-gate precedence tests;
8. healthy hysteresis tests including 15% threshold;
9. failed-canary suppression tests: cooldown, minimum new cycles, operator-required retry for client-sanity/post-publish failure;
10. shadow-lineage persistence tests;
11. shadow measurement-cohort union including pinned baseline;
12. production measurement-cohort union including the current experiment baseline until safe terminal state;
13. incomplete-measurement hold tests;
14. retained-count fallback tests (`6+2`, guarded `5+3`, no normal `4+4`);
15. normal one-wave/multi-wave newcomer canary tests;
16. recovery-canary tests proving unhealthy recovery cannot directly graduate unobserved replacements;
17. baseline pinning/revalidation/degraded-restore tests;
18. fresh-authority-before-every-experiment tests, including a manual/authorized mutation between graduated experiments;
19. termination tests proving an ungraduated current canary cannot become the next baseline by termination alone;
20. manual-authority interlock tests: activation blocked when manual is effective, racing manual takeover prevents success/graduation, clearing manual requires fresh experiment handoff;
21. promoted revision/source/pool identity checks before graduation;
22. expected-revision CAS conflict tests;
23. bounded persistence/corruption tests;
24. NAS Docker validation.

No production publication changes until shadow evidence is reviewed.

## 23. Acceptance gates before v2 controls publication

- Stage B remains authoritative during shadow collection.
- Current seven-day fixed-seed experiment remains unchanged.
- Historical scoring is derived only from the canonical retained 30-day detailed-run window prior to the current cycle.
- Cache state equals deterministic rebuild after run pruning; pruned runs cannot retain hidden influence.
- EWMA reconstruction from the same ordered window is deterministic.
- Confidence aggregation has frozen cycle/coverage/UTC-daypart semantics and is reproducible from the same records.
- Shadow and production restore baselines are mandatorily measured through graduation or safe terminal reconciliation.
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
- **every** production experiment freshly reads and pins the real authority it is about to replace; no prior graduated baseline is reused blindly.
- manual override / unrevisioned effective authority blocks v2 production mutation and graduation; racing manual takeover cannot be reported as successful v2 authority.
- termination cannot clear provenance or admit an ungraduated serving canary as a future stable baseline.
- no shadow restore point can become a production restore target.
- graduation verifies effective source, revision, entries, and fingerprint identity.
- eventual real optimizer mutations remain CAS protected.
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
HISTORY_WINDOW_DAYS=30
```

Still empirical until follow-up data is reviewed:

- 36h versus nearby EWMA half-lives;
- confidence maturity thresholds;
- canary/recovery-canary observation duration beyond the minimum subsequent cycle;
- guarded `5+3` behavior;
- challengers per wave;
- 15% versus nearby hysteresis thresholds;
- failed-canary cooldown/new-evidence thresholds;
- adaptive sampling ratio.

The 30-day canonical scoring window is initially aligned to retained detailed-run evidence for rebuild correctness; changing it later requires changing detailed-run retention or introducing an independently validated canonical checkpoint scheme first.

Empirical values may change. Safety invariants do not: deterministic retained-evidence rebuild, deterministic confidence, normalized bounded blending, explicit healthy hysteresis, deterministic retry suppression, complete restore-path measurement, observed recovery-canaries, fresh authority pinning before every production experiment, safe termination provenance, and manual-authority interlock are mandatory.
