# B2 Stage D — Selective Fallback, Production Rollout, and Privacy Scrub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable evidence-backed selective direct-to-NAS fallback for only proven problem domains, validate behavior from the real client, then remove operator-specific identifiers from the public repository’s current branch.

**Architecture:** Stage D converts the Stage A observation state machine into a pre-response fallback state machine using Stage C dialers. It preserves direct as the global default, forbids mid-stream route changes, deploys one target at a time as a canary, and closes with privacy/documentation cleanup plus an optional separately approved Git-history rewrite decision.

**Tech Stack:** Cloudflare Workers JavaScript, direct/NAS dialer abstraction, KV/structured diagnostics, Git/GitHub, Node.js tests.

## Global Constraints

- Production fallback is allowed only for target keys with real-session direct failure/stall evidence plus successful NAS path evidence.
- Default route remains direct; global wildcard is forbidden.
- `fallback_domains`: direct first, NAS only before any upstream response byte.
- `force_egress_domains`: NAS only, fail closed; use only when explicitly justified.
- Fallback triggers: direct open error/timeout, close-before-byte, or no first byte within 8 seconds after initial client payload.
- No fallback after first upstream response byte.
- NAS downtime must not break direct-only traffic.
- Rollout is one evidence-backed target at a time.
- Final current-branch privacy scrub replaces/deletes operator-specific deployment identifiers where not technically required.
- History rewrite is not automatic; it requires a separate explicit approval.

---

## File Structure

- Modify `src/core/proxy.js` — actual pre-response fallback state machine.
- Modify `src/core/dialers.js` — helper for policy-selected direct/NAS attempts.
- Modify `src/ops/egress-policy.js` — production policy resolution remains pure/label-boundary aware.
- Modify `src/ops/egress-diagnostics.js` — record bounded fallback outcome events.
- Modify `src/index.js` / generated deploy config — production lists injected via env/config, not source literals.
- Create/modify tests `test/core/egress-fallback.test.js`, `test/ops/egress-policy.test.js`.
- Create `docs/operations/b2-canary-and-rollback.md` during rollout, then generalize/delete operator-specific one-off records in privacy task.
- Modify repository docs/config examples found by privacy scan.

### Task 1: Convert observation timeout into a reusable pre-response state machine

**Files:** `src/core/proxy.js`, `src/core/dialers.js`, `test/core/egress-fallback.test.js`

**Interfaces:**
- `forwardPreResponse({directDialer,nasDialer,policy,target,initialData,timeoutMs,onEvent}) -> Promise<Socket>` or equivalent focused helper.
- State guarantees: `direct_attempt -> first_byte|pre_response_failure -> nas_attempt` only for fallback policy.

- [ ] Write deterministic tests for:
  - direct success with first byte -> never call NAS;
  - direct open error -> NAS called once;
  - direct closes before byte -> NAS called once;
  - direct has no byte for 8000ms -> direct socket closed then NAS called once;
  - direct sends one byte at 7999ms -> timer cancelled, no NAS;
  - NAS failure after direct failure -> stream fails/WS closes;
  - force policy -> direct never called;
  - direct policy -> NAS never called.

- [ ] Run: `node --test test/core/egress-fallback.test.js`; expected FAIL before implementation.
- [ ] Implement with injected timers in tests; production uses normal timer. Ensure initial client payload is written exactly once to the winning path and never duplicated after response forwarding starts.
- [ ] Ensure losing/abandoned sockets are closed and readers/writers release locks.
- [ ] Run focused/full tests; expected PASS.
- [ ] Commit: `feat: add pre-response selective egress fallback`.

### Task 2: Wire pure policy resolution into forwarding

**Files:** `src/core/proxy.js`, `src/ops/egress-policy.js`, `test/ops/egress-policy.test.js`

- [ ] Extend tests to prove suffix precedence: force beats fallback for the same matched hostname; exact/subdomain boundary behavior; IP literals resolve direct; empty lists resolve direct; wildcard is rejected.
- [ ] Run focused tests; expected PASS/FAIL only for newly added cases.
- [ ] In the real forwarding path, resolve once per destination before dialing and pass enum `direct|fallback|force` into the state machine.
- [ ] Do not hard-code X, Twitter, JavDB, or any operator hostname in source.
- [ ] Run full suite.
- [ ] Commit: `feat: apply explicit egress domain policy`.

### Task 3: Bound fallback observability without browsing-history expansion

**Files:** `src/ops/egress-diagnostics.js`, `src/core/proxy.js`, `test/core/egress-fallback.test.js`

- [ ] Add assertions that events are limited to configured target key + event + elapsed milliseconds. Required event set:

```text
fallback_direct_open_error
fallback_direct_closed_before_byte
fallback_direct_first_byte_timeout
fallback_nas_open_ok
fallback_nas_open_error
force_nas_open_ok
force_nas_open_error
```

- [ ] Verify unconfigured direct-only destinations produce no destination-specific event.
- [ ] Implement bounded event calls at state transitions; never include raw hostname, URL, SNI, destination IP, payload, token or UUID.
- [ ] Run tests and commit: `feat: record bounded fallback outcomes`.

### Task 4: Evidence gate and single-target canary rollout

**Files:** `docs/operations/b2-canary-and-rollback.md`, deployment environment only.

- [ ] Before changing policy, capture Stage A/C evidence for one target key: real-session direct failure/stall event and synthetic/private NAS open success.
- [ ] If evidence is absent or NAS also fails, record `unresolved` and do not add a fallback domain.
- [ ] Add exactly one proven domain/suffix to runtime `FALLBACK_DOMAINS`; keep `FORCE_EGRESS_DOMAINS` empty initially.
- [ ] Deploy and verify from actual client network: baseline direct services still load; canary service loads; refresh/reconnect multiple times; NAS shutdown leaves baseline direct services functional and causes only canary fallback to fail after direct+NAS attempts.
- [ ] If canary regresses, clear fallback runtime list and redeploy; do not patch additional code during rollback.
- [ ] Only after one target passes may another evidence-backed target be added.
- [ ] Commit only generalized rollout documentation, not real production target names.

### Task 5: Optimizer production scheduling acceptance

**Files:** `docs/operations/nas-optimizer.md`, NAS runtime configuration only.

- [ ] Confirm one manual full cycle and rollback drill already passed Stage B exit gate.
- [ ] Enable `PUBLISH_ENABLED=true` and daemon or NAS scheduler with fast 6-hour/full daily cadence.
- [ ] Observe at least two cycles: no overlapping lock, history written, current winners re-tested, no publish when improvement <15%, and no pool erasure when eligible count <4.
- [ ] Verify client subscription after a legitimate pool promotion and confirm client-side `url-test` continues selecting among Top-8 rather than relying on a single NAS-selected address.
- [ ] Document disabling scheduler as first rollback action.

### Task 6: Repository privacy inventory

**Files:** repository-wide scan; no history rewrite yet.

- [ ] Build a list of known operator-specific literals to scan: production domain/hostname, worker/service names if personally identifying, account/zone/tunnel IDs, internal/private addresses, one-off deployment filenames and environment labels.
- [ ] Run repository current-tree scans using `git grep -n -F '<literal>' -- .` for each known literal and a generic scan for credential-like patterns (`API_TOKEN`, UUID literals, tunnel tokens, private RFC1918 addresses in docs/config).
- [ ] Classify each hit as `runtime-required`, `reusable-example`, or `one-off-audit`.
- [ ] Verify no secret value is present before proceeding; if a real secret is found, stop normal scrub and rotate/revoke it first.

### Task 7: Current-branch privacy scrub

**Files:** all current-tree hits from Task 6.

- [ ] Replace reusable examples with `${EDGE_HOSTNAME}`, `${WORKER_BASE_URL}`, `${NAS_EGRESS_HOST}`, `<example-zone-id>`, `<example-tunnel-id>` and `example.invalid` where appropriate.
- [ ] Move production values out of committed `wrangler.toml`/docs into generated config or GitHub/NAS environment variables.
- [ ] Delete one-off deployment request/result docs that no longer serve ongoing operations, or rewrite them as generic procedures without operator-specific literals.
- [ ] Keep no actual `OPTIMIZER_TOKEN`, ADMIN, UUID, tunnel credential or API token in Git.
- [ ] Re-run all literal scans; expected zero hits except explicitly approved runtime-required values. Prefer zero operator-specific literals in public current branch.
- [ ] Run `npm test && npm run check && node --test optimizer/test/*.test.js` plus Docker Compose config checks.
- [ ] Commit: `chore: scrub operator-specific deployment identifiers`.

### Task 8: Decide separately whether to rewrite Git history

**Files:** none until explicit approval.

- [ ] Produce a report listing which operator-specific identifiers remain in historical commits even though current tree is clean.
- [ ] Explain impact of history rewrite: force-push, changed commit SHAs, stale forks/clones/PR links, collaborators must re-clone or reset.
- [ ] If user does **not** explicitly approve history rewrite, stop here and mark current-tree privacy scrub complete.
- [ ] If explicitly approved in a future turn, create a separate `git filter-repo` plan with backup refs, replacement map, remote force-push procedure, verification and GitHub cache/fork considerations. Do not perform history rewrite as an incidental B2 step.

### Task 9: Final B2 verification and closure

- [ ] Run all root Worker tests/checks.
- [ ] Run all optimizer tests.
- [ ] Validate generated Wrangler config and NAS Compose files.
- [ ] Confirm direct-only baseline services remain functional.
- [ ] Confirm each enabled fallback domain has evidence and real-client success.
- [ ] Stop NAS egress and prove direct-only traffic still works.
- [ ] Stop optimizer and prove last materialized `ADD.txt` remains usable.
- [ ] Trigger explicit pool rollback and verify prior revision.
- [ ] Verify public current branch privacy scan is clean.
- [ ] Record only generalized final architecture/operations docs.
- [ ] Commit final verification record if it contains no operator-specific identifiers: `docs: close B2 rollout and privacy acceptance`.

## B2 Completion Gate

B2 is complete only when ingress optimizer automation is stable, selective egress fallback is backed by evidence rather than assumptions, direct traffic survives NAS outages, rollback is proven, and the public repository current branch no longer contains unnecessary operator-specific deployment identifiers.
