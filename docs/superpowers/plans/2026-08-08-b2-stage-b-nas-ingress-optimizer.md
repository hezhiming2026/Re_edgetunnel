# B2 Stage B — NAS Ingress Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a NAS-hosted optimizer that measures Cloudflare ingress candidates from the real client network, selects a stable Top-8, and safely publishes revisioned pools through the Stage A machine API.

**Architecture:** A standalone Node.js optimizer runs one-shot or daemon cycles. It samples official Cloudflare IPv4 ranges plus current winners and operator seeds, performs real TLS/SNI probes against the Worker, scores eligible candidates, applies hysteresis/diversity gates, persists last-known-good state, and publishes only through the revision-checked API.

**Tech Stack:** Node.js 22+, built-in `net`, `tls`, `https`/Web Streams, `node:test`, Docker/Compose. No Cloudflare account API token in the optimizer.

## Global Constraints

- V1 measures IPv4 on port 443 only.
- Probe SNI and Host come from `EDGE_HOSTNAME`; no operator hostname is committed as a default.
- Fast cycle ~64 candidates every 6 hours; full cycle ~192 daily.
- Each candidate receives 3 rounds; eligibility requires >=2 successes, certificate validation, Worker probe success, median TTFB <=1500 ms.
- Score weights: 45% reliability, 25% median TTFB percentile, 15% p95 duration percentile, 15% bounded throughput percentile.
- Top-8, max 2 addresses per `/24`, no duplicates.
- Fewer than 4 eligible candidates -> no publish.
- Promotion requires current pool unhealthy (<4 current entries eligible) or >=15% median score improvement.
- Detailed run retention 30 days; summaries 180 days.
- State survives container restart.
- No third-party preferred-IP feeds in v1.

---

## File Structure

- Create `optimizer/package.json` — independent Node package scripts.
- Create `optimizer/src/candidates.js` — CIDR sampling/current/seed merge.
- Create `optimizer/src/probe.js` — TCP/TLS/HTTP probe against candidate IP with SNI.
- Create `optimizer/src/score.js` — eligibility, percentile scoring, Top-N/diversity/hysteresis.
- Create `optimizer/src/state.js` — atomic JSON/JSONL persistence and retention.
- Create `optimizer/src/api.js` — machine API client with revision conflicts/rollback.
- Create `optimizer/src/run.js` — single-cycle orchestration.
- Create `optimizer/src/cli.js` — `run --mode fast|full` and `daemon`.
- Create `optimizer/test/*.test.js` — deterministic unit/integration tests.
- Create `deploy/nas/optimizer.Dockerfile` and `deploy/nas/docker-compose.optimizer.yml`.
- Create `deploy/nas/optimizer.env.example` using placeholders only.
- Modify root `package.json` to add `test:optimizer` wrapper if desired.

### Task 1: Candidate model and official CIDR sampling

**Files:** `optimizer/src/candidates.js`, `optimizer/test/candidates.test.js`

**Interfaces:**
- `parseCidrs(text) -> Cidr[]`
- `sampleIpv4Cidrs(cidrs, count, rng) -> string[]`
- `buildCandidateSet({current,seeds,cidrs,targetCount,rng}) -> string[]`

- [ ] Write tests proving current winners are always retained, seeds are de-duplicated, random samples stay inside allowed CIDRs, and deterministic injected RNG produces reproducible output.

```js
assert.deepEqual(buildCandidateSet({
  current: ['104.16.1.1'], seeds: ['104.16.2.2','104.16.1.1'],
  cidrs: parseCidrs('104.16.0.0/13'), targetCount: 4, rng: () => 0.25,
}).slice(0,2), ['104.16.1.1','104.16.2.2']);
```

- [ ] Run: `node --test optimizer/test/candidates.test.js`; expected FAIL before implementation.
- [ ] Implement unsigned IPv4 math; exclude network/broadcast only where meaningful for prefixes <=30; avoid duplicates with `Set`.
- [ ] Run focused tests; expected PASS.
- [ ] Commit: `git commit -m "feat: add optimizer candidate sampling"`.

### Task 2: Real ingress probe with candidate IP + SNI

**Files:** `optimizer/src/probe.js`, `optimizer/test/probe.test.js`

**Interfaces:**
- `probeCandidate({address,hostname,token,timeoutMs,payloadPath}, deps) -> Promise<ProbeRound>`
- `ProbeRound = {ok,tcpMs,tlsMs,ttfbMs,totalMs,bytes,status,error}`

- [ ] Write a local TLS-server integration test with a test certificate fixture and injected CA, verifying socket destination is IP while TLS `servername` and HTTP `Host` equal the configured hostname.
- [ ] Run focused test; expected FAIL.
- [ ] Implement `tls.connect({host: address, port:443, servername:hostname, rejectUnauthorized:true})`, write an HTTP/1.1 GET to `/ops/optimizer/v1/probe` with `Authorization: Bearer ...`, record connect/secure-connect/first-data/end timings, cap bytes at 64 KiB, and destroy on timeout.
- [ ] Never disable certificate validation in production. Test-only CA injection is explicit dependency/config.
- [ ] Run focused tests; expected PASS.
- [ ] Commit: `feat: probe real Cloudflare ingress paths`.

### Task 3: Eligibility, percentile scoring, Top-8 diversity and hysteresis

**Files:** `optimizer/src/score.js`, `optimizer/test/score.test.js`

**Interfaces:**
- `summarizeCandidate(rounds) -> CandidateSummary`
- `scoreCandidates(summaries,currentSet) -> ScoredCandidate[]`
- `selectPool(scored,{size:8,maxPer24:2}) -> ScoredCandidate[]`
- `shouldPromote({current,proposed}) -> {promote:boolean,reason:string}`

- [ ] Write deterministic tests for 2/3 success eligibility, >1500ms median TTFB rejection, inverse percentile ordering, tie favoring current entry, max-two-per-/24, fewer-than-four no-publish, current-unhealthy promotion, and exactly 14.9% vs 15.0% improvement threshold.
- [ ] Run focused test; expected FAIL.
- [ ] Implement percentiles using stable rank with deterministic address tie-break after current-pool preference.
- [ ] Represent score in [0,1], higher better; compute proposed/current median over entries actually re-tested in same cycle.
- [ ] Run tests; expected PASS.
- [ ] Commit: `feat: score and stabilize optimizer pools`.

### Task 4: Crash-safe state, history and retention

**Files:** `optimizer/src/state.js`, `optimizer/test/state.test.js`

**Interfaces:**
- `loadState(dataDir)`, `writeAtomicJson(path,value)`, `appendHistory(summary)`, `saveRun(run)`, `pruneRuns(now)`.

- [ ] Write tests using a temporary directory: atomic write leaves valid old or new JSON, never partial; restart reloads current/previous/last-good; retention deletes detailed runs older than 30 days while history pruning keeps <=180 days.
- [ ] Run focused test; expected FAIL.
- [ ] Implement write-to-temp + fsync + rename for JSON snapshots; JSONL append with one line per cycle; never serialize token/base URL credentials.
- [ ] Run tests; expected PASS.
- [ ] Commit: `feat: persist optimizer last-known-good state`.

### Task 5: Machine API publisher with 409 conflict and rollback

**Files:** `optimizer/src/api.js`, `optimizer/test/api.test.js`

**Interfaces:**
- `getStatus(config)`, `publishPool(config,{expectedRevision,entries})`, `rollback(config,{expectedRevision})`, `verifyProbe(config,address?)`.

- [ ] Use a local HTTP mock server to test Authorization header, JSON body, 409 surfaced as typed `RevisionConflictError`, non-2xx body capped before error logging, and token never appears in thrown error text.
- [ ] Run focused test; expected FAIL.
- [ ] Implement fetch calls with AbortController timeouts and `Cache-Control: no-store`; do not retry 409 automatically.
- [ ] Run tests; expected PASS.
- [ ] Commit: `feat: publish optimizer revisions safely`.

### Task 6: One-shot cycle orchestration and post-publish rollback

**Files:** `optimizer/src/run.js`, `optimizer/test/run.test.js`

**Interfaces:**
- `runCycle(config,{mode,deps}) -> Promise<RunSummary>`

- [ ] Write mocked end-to-end tests: healthy proposed pool dry-run; publish success updates last-good; publish then verification failure invokes rollback; insufficient healthy candidates does not call publish; 409 records conflict and does not rollback somebody else's revision.
- [ ] Run focused test; expected FAIL.
- [ ] Implement sequence: load state -> status -> build candidates -> 3 rounds each with bounded concurrency (default 12) -> score/select -> promotion decision -> save run -> optional publish -> verify Worker/subscription materialization -> rollback only the revision just published if verification fails.
- [ ] Run tests; expected PASS.
- [ ] Commit: `feat: orchestrate optimizer cycles`.

### Task 7: CLI, daemon cadence and local process lock

**Files:** `optimizer/src/cli.js`, `optimizer/package.json`, `optimizer/test/cli.test.js`

**Interfaces:**
- `node optimizer/src/cli.js run --mode fast [--dry-run]`
- `node optimizer/src/cli.js run --mode full [--dry-run]`
- `node optimizer/src/cli.js daemon`

- [ ] Test invalid mode exits non-zero, missing required env exits non-zero without printing token, second concurrent process cannot acquire lock, and daemon schedules 6-hour fast + daily full without overlapping cycles using injected scheduler clock.
- [ ] Implement required env: `WORKER_BASE_URL`, `EDGE_HOSTNAME`, `OPTIMIZER_TOKEN`, `DATA_DIR`; optional seed/CIDR/config values.
- [ ] Default first production run is `--dry-run`; publishing requires explicit `PUBLISH_ENABLED=true`.
- [ ] Run `node --test optimizer/test/*.test.js`; expected PASS.
- [ ] Commit: `feat: add optimizer CLI and scheduler`.

### Task 8: Containerize NAS optimizer without privileged networking

**Files:** `deploy/nas/optimizer.Dockerfile`, `deploy/nas/docker-compose.optimizer.yml`, `deploy/nas/optimizer.env.example`, `docs/operations/nas-optimizer.md`

- [ ] Build image from pinned Node major, run as non-root user, read-only root filesystem where practical, mount only `/data` writable, no host networking, no privileged mode, no Docker socket.
- [ ] Compose must not publish any ports; optimizer only initiates outbound HTTPS/TLS.
- [ ] Example env contains only `${WORKER_BASE_URL}` / `${EDGE_HOSTNAME}` style placeholders and documents storing `OPTIMIZER_TOKEN` outside Git.
- [ ] Run: `docker compose -f deploy/nas/docker-compose.optimizer.yml config`; expected valid config with no published ports.
- [ ] Run full tests: `npm test && npm run check && node --test optimizer/test/*.test.js`.
- [ ] Commit: `ops: package NAS ingress optimizer`.

## Stage B Exit Gate

- Full dry-run from the actual NAS network produces bounded metrics and a valid candidate ranking.
- A controlled publish creates a new revision and materialized `ADD.txt`; subscription output contains the selected pool.
- Forced verification failure proves rollback restores previous revision.
- Stopping/restarting the container preserves state.
- No Cloudflare account API token exists in optimizer env/config/state.
- Do not begin automatic daemon publishing until at least one manual full cycle + rollback drill passes.
