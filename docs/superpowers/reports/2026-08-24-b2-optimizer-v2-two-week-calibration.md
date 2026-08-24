# B2 Optimizer v2 — two-week NAS calibration addendum

Date: 2026-08-24
Status: design calibration only; no production publication behavior change

## Scope and privacy

This document records only aggregate conclusions derived from an operator-owned NAS measurement window. Raw measurement files, operator-specific addresses, hostnames, tokens, and exact seed lists are intentionally not committed.

The calibration window contained more than two weeks of scheduled measurement cycles and thousands of candidate observations. The exact environment remains private.

## Findings

1. Per-address repeat coverage was sparse under predominantly random sampling. This confirms that stable fixed seeds are required before per-address historical confidence can be considered mature.
2. Prefix-level performance was strongly non-uniform. Uniform sampling across all allowed Cloudflare IPv4 space wastes a material portion of the measurement budget in historically low-yield regions.
3. Current-cycle network performance changes quickly enough that historical evidence must remain secondary to current hard gates and current-cycle score.
4. A single global EWMA half-life in the 24–48 hour range is a reasonable initial shadow operating region; 36 hours is the preferred first shadow value because it balances reliability, TTFB, total time, and throughput without materially over-weighting stale evidence.

## Initial shadow calibration

These values are recommendations for shadow evaluation, not permanent production constants:

```text
EWMA_HALF_LIFE_HOURS=36
MAX_HISTORY_WEIGHT=0.30
```

Historical blending remains:

```text
historical_weight = MAX_HISTORY_WEIGHT * confidence
final_score = instant_score * (1 - historical_weight)
            + stability_score * historical_weight
```

Current-cycle hard eligibility always runs first. History can never rescue a currently ineligible candidate.

## Confidence maturity

Confidence MUST depend on independent temporal coverage, not only raw observation count.

Recommended initial gates:

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

A candidate repeatedly measured many times in one short burst MUST NOT become high-confidence merely because the raw sample count is large.

A conservative confidence composition is:

```text
cycle_confidence    = min(cycles_seen / 24, 1)
coverage_confidence = min(coverage_hours / 120, 1)
daypart_confidence  = min(dayparts_seen / 4, 1)
confidence          = min(cycle_confidence, coverage_confidence, daypart_confidence)
```

The exact formula remains a shadow-mode calibration item.

## Seed cohort requirement

Before historical scoring controls publication, the NAS should maintain a bounded fixed seed cohort alongside random exploration so that individual candidates accumulate repeat evidence across multiple days and dayparts.

Operator-specific seed addresses MUST remain in local `optimizer.env`; they MUST NOT be committed to the public repository.

## Adaptive stratified sampling

Optimizer v2 should add an explicit exploration/exploitation sampler instead of permanently sampling the entire allowed IPv4 space uniformly.

Initial design target:

```text
70–80% measurement budget: historically productive strata/prefixes and fixed seeds
20–30% measurement budget: unbiased exploration across the full allowed Cloudflare IPv4 set
```

Safety invariants:

- no allowed Cloudflare range is permanently blacklisted solely from historical poor performance;
- the exploration fraction never becomes zero;
- current winners and configured seeds are always retained;
- sampling weights are derived only from local bounded historical evidence;
- corrupt or insufficient historical sampling state falls back to the Stage B sampler;
- adaptive sampling does not itself authorize publication.

This is deliberately separate from candidate scoring. Sampling decides what to measure; hard gates and scoring decide what is eligible and preferred.

## Next evidence gate

After introducing a fixed local seed cohort, collect at least seven more days while `PUBLISH_ENABLED=false` and keeping probe timeout, API timeout, concurrency, and fast/full random candidate counts unchanged.

Re-evaluate:

- seed eligibility rate and failure streaks;
- daypart stability;
- 36h versus nearby EWMA half-lives;
- confidence maturity thresholds;
- Stage B versus v2-shadow Top-N overlap;
- whether adaptive sampling reduces wasted probes without losing newly good regions.

No v2 automatic publication should be enabled until that follow-up evidence is reviewed.
