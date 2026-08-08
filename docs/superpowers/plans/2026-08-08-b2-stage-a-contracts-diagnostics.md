# B2 Stage A — Contracts and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add machine-authenticated optimizer contracts, versioned pool management, bounded probe endpoints, domain policy parsing, and observation-only egress diagnostics without changing production routing.

**Architecture:** Stage A adds narrowly scoped `/ops/*` APIs and pure policy/validation modules. The existing proxy remains direct-only; diagnostic domains emit bounded event keys and first-byte timings but do not yet fall back to NAS. Pool writes use immutable revisions plus optimistic concurrency before materializing `ADD.txt`.

**Tech Stack:** Cloudflare Workers JavaScript modules, KV, Node.js built-in `node:test`, Web Streams, `cloudflare:sockets` for direct diagnostic opens.

## Global Constraints

- No production fallback domains in Stage A.
- No automatic production `ADD.txt` updates outside explicit authenticated `PUT /ops/optimizer/v1/pool`.
- `OPTIMIZER_TOKEN` is independent of `ADMIN` and `UUID` and cannot authorize browser-admin routes.
- Optimizer publisher accepts only validated Cloudflare IPv4 candidates on port 443, max 16 entries, max 2 per `/24`.
- Every pool/rollback mutation requires `expected_current_revision`; stale callers receive HTTP 409 with no mutation.
- Diagnostic API accepts only configured target keys; never arbitrary hosts, ports, URLs, or request payloads.
- Normal browsing history and payloads are not logged.
- First-byte observation timeout defaults to 8 seconds, but Stage A records only; it does not reroute.
- New code/config examples use environment placeholders rather than operator-specific production identifiers.

---

## File Structure

- Create `src/ops/auth.js` — machine token extraction and timing-resistant comparison.
- Create `src/ops/cidr.js` — IPv4/CIDR parsing, membership and `/24` helpers.
- Create `src/ops/pool-store.js` — pool validation, revision/checksum, publish/rollback/status KV contract.
- Create `src/ops/optimizer-api.js` — `/ops/optimizer/v1/*` HTTP handlers.
- Create `src/ops/egress-policy.js` — target-key parsing and suffix matching.
- Create `src/ops/egress-diagnostics.js` — bounded synthetic direct diagnostic contract and observation event helpers.
- Modify `src/index.js` — route `/ops/*` before browser-admin routing and pass observation config into proxy config.
- Modify `src/core/proxy.js` — observation-only pre-response lifecycle events; no fallback.
- Modify `src/config.js` — parse non-secret diagnostic configuration without storing target history.
- Modify `package.json` — add syntax checks for new modules.
- Create tests under `test/ops/*.test.js` and `test/core/egress-observation.test.js`.

### Task 1: Machine-only authentication boundary

**Files:**
- Create: `src/ops/auth.js`
- Modify: `src/index.js`
- Test: `test/ops/auth.test.js`

**Interfaces:**
- Produces: `authenticateMachineRequest(request, env) -> Promise<boolean>`
- Produces: `machineUnauthorized() -> Response`
- Consumes: Worker secret `env.OPTIMIZER_TOKEN`

- [ ] **Step 1: Write failing authentication tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateMachineRequest } from '../../src/ops/auth.js';

const req = (value) => new Request('https://example.invalid/ops/optimizer/v1/status', {
  headers: value ? { Authorization: value } : {},
});

test('machine auth requires exact bearer token', async () => {
  const env = { OPTIMIZER_TOKEN: 'optimizer-secret-1234567890' };
  assert.equal(await authenticateMachineRequest(req(), env), false);
  assert.equal(await authenticateMachineRequest(req('Bearer wrong'), env), false);
  assert.equal(await authenticateMachineRequest(req('Basic optimizer-secret-1234567890'), env), false);
  assert.equal(await authenticateMachineRequest(req('Bearer optimizer-secret-1234567890'), env), true);
});

test('machine auth fails closed when token is unset', async () => {
  assert.equal(await authenticateMachineRequest(req('Bearer anything'), {}), false);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test test/ops/auth.test.js`
Expected: FAIL because `src/ops/auth.js` does not exist.

- [ ] **Step 3: Implement minimal timing-resistant auth**

Use `crypto.subtle.digest('SHA-256', ...)` on both UTF-8 byte strings and compare all 32 digest bytes without early return after length/format validation. Reject tokens shorter than 24 characters so accidental weak values fail closed.

```js
export async function authenticateMachineRequest(request, env) {
  const expected = typeof env.OPTIMIZER_TOKEN === 'string' ? env.OPTIMIZER_TOKEN : '';
  const match = request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/);
  if (!match || expected.length < 24) return false;
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(match[1])),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
```

- [ ] **Step 4: Route `/ops/*` through machine auth only**

In `src/index.js`, before `/login` and `/admin` handling, detect `pathLower.startsWith('ops/')`; unauthenticated requests return JSON 401 and never call browser-admin auth. Do not make `/admin/*` accept `OPTIMIZER_TOKEN`.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/ops/auth.test.js && npm test && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ops/auth.js src/index.js test/ops/auth.test.js package.json
git commit -m "feat: add machine-only ops authentication"
```

### Task 2: CIDR and optimizer pool validation

**Files:**
- Create: `src/ops/cidr.js`
- Create: `src/ops/pool-store.js`
- Test: `test/ops/pool-validation.test.js`

**Interfaces:**
- Produces: `parseAllowedCidrs(value) -> Array<{network:number, mask:number, prefix:number}>`
- Produces: `validatePoolEntries(entries, allowedCidrs) -> Array<{address,port,name}>`
- Produces: `formatAddTxt(entries) -> string`

- [ ] **Step 1: Write failing validation tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedCidrs, validatePoolEntries } from '../../src/ops/pool-store.js';

const allowed = parseAllowedCidrs('104.16.0.0/13,172.64.0.0/13');

test('accepts Cloudflare IPv4 port 443 entries', () => {
  const result = validatePoolEntries([
    { address: '104.16.1.1', port: 443, name: 'rank-01' },
    { address: '104.16.2.2', port: 443, name: 'rank-02' },
  ], allowed);
  assert.equal(result.length, 2);
});

test('rejects non-443, duplicates, foreign CIDRs, and third address in one /24', () => {
  assert.throws(() => validatePoolEntries([{ address: '104.16.1.1', port: 8443, name: 'bad' }], allowed));
  assert.throws(() => validatePoolEntries([{ address: '203.0.113.10', port: 443, name: 'bad' }], allowed));
  assert.throws(() => validatePoolEntries([
    { address: '104.16.1.1', port: 443, name: 'a' },
    { address: '104.16.1.2', port: 443, name: 'b' },
    { address: '104.16.1.3', port: 443, name: 'c' },
  ], allowed));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/ops/pool-validation.test.js`
Expected: FAIL because pool validation exports do not exist.

- [ ] **Step 3: Implement strict IPv4/CIDR parsing**

Implement integer IPv4 conversion without DNS resolution. Reject leading/trailing junk, octets outside 0..255, prefix outside 0..32, empty CIDR sets, labels longer than 64 UTF-8 characters, CR/LF/NUL/control characters, duplicate IPs, >16 entries, and >2 addresses per `/24`.

- [ ] **Step 4: Materialize canonical ADD text**

`formatAddTxt()` must emit one canonical line per validated entry: `${address}:443#${name}` and terminate with exactly one newline. No raw caller text reaches KV.

- [ ] **Step 5: Run tests**

Run: `node --test test/ops/pool-validation.test.js && npm test && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ops/cidr.js src/ops/pool-store.js test/ops/pool-validation.test.js package.json
git commit -m "feat: validate optimizer ingress pools"
```

### Task 3: Revisioned publish, status, and rollback KV contract

**Files:**
- Modify: `src/ops/pool-store.js`
- Create: `src/ops/optimizer-api.js`
- Test: `test/ops/pool-store.test.js`

**Interfaces:**
- Produces: `publishPool(env, requestBody, allowedCidrs) -> Promise<{revision,checksum,previous}>`
- Produces: `rollbackPool(env, expectedCurrentRevision) -> Promise<{revision,checksum}>`
- Produces: `readPoolStatus(env) -> Promise<object>`

- [ ] **Step 1: Write an in-memory KV fake and failing concurrency tests**

```js
class MemoryKV {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
}

test('stale expected revision performs no writes', async () => {
  const kv = new MemoryKV({ 'optimizer:current': 'rev-new', 'ADD.txt': '104.16.1.1:443#old\n' });
  const env = { KV: kv };
  await assert.rejects(() => publishPool(env, {
    expected_current_revision: 'rev-old',
    entries: [{ address: '104.16.2.2', port: 443, name: 'new' }],
  }, allowed), (err) => err.status === 409);
  assert.equal(await kv.get('ADD.txt'), '104.16.1.1:443#old\n');
});
```

Also test first publish from `null`, second publish sets `optimizer:previous`, rollback restores the immutable previous snapshot, and rollback with stale revision produces no mutation.

- [ ] **Step 2: Run failing tests**

Run: `node --test test/ops/pool-store.test.js`
Expected: FAIL because store operations are not implemented.

- [ ] **Step 3: Implement revision and checksum generation**

Create revision as UTC compact timestamp plus first 12 hex characters of SHA-256 over canonical JSON entries. Store immutable JSON at `optimizer:pool:<revision>`. Store status JSON with last mutation type/time/revision/checksum. Never derive revision from a secret.

- [ ] **Step 4: Implement HTTP handlers**

`PUT /ops/optimizer/v1/pool` parses JSON with a 16 KiB body limit, maps stale revision to HTTP 409, validation to 400, success to 200. `POST /rollback` accepts only `{expected_current_revision}`. `GET /status` returns current/previous/status and never returns immutable snapshot bodies unless explicitly needed by later plans.

- [ ] **Step 5: Run focused/full suite**

Run: `node --test test/ops/pool-store.test.js && npm test && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ops/pool-store.js src/ops/optimizer-api.js test/ops/pool-store.test.js
git commit -m "feat: add revisioned optimizer pool API"
```

### Task 4: Bounded ingress probe endpoint

**Files:**
- Modify: `src/ops/optimizer-api.js`
- Test: `test/ops/optimizer-probe.test.js`

**Interfaces:**
- Produces: `buildOptimizerProbeResponse() -> Response`
- Endpoint: authenticated `GET /ops/optimizer/v1/probe`

- [ ] **Step 1: Write failing probe test**

```js
test('probe returns deterministic 64 KiB body with no-store', async () => {
  const response = buildOptimizerProbeResponse();
  const body = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(body.byteLength, 64 * 1024);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
});
```

- [ ] **Step 2: Run failing test**

Run: `node --test test/ops/optimizer-probe.test.js`
Expected: FAIL because probe response is not implemented.

- [ ] **Step 3: Implement deterministic payload**

Generate the 64 KiB payload from a fixed repeated byte sequence in Worker memory; do not call `fetch()`, KV, or an arbitrary remote origin. Add `X-Optimizer-Probe-Version: 1` and `Cache-Control: no-store`.

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/ops/optimizer-probe.test.js && npm test && npm run check`
Expected: PASS.

```bash
git add src/ops/optimizer-api.js test/ops/optimizer-probe.test.js
git commit -m "feat: add bounded ingress probe endpoint"
```

### Task 5: Domain policy and diagnostic target configuration

**Files:**
- Create: `src/ops/egress-policy.js`
- Modify: `src/config.js`
- Test: `test/ops/egress-policy.test.js`

**Interfaces:**
- Produces: `parseDomainSuffixList(value) -> string[]`
- Produces: `matchDomainSuffix(hostname, suffixes) -> boolean`
- Produces: `parseDiagnosticTargets(value) -> Map<string,{hostname:string,port:number}>`
- Produces: `resolveEgressPolicy(hostname, config) -> 'direct'|'fallback'|'force'`

- [ ] **Step 1: Write failing boundary tests**

```js
test('suffix matching honors DNS label boundaries', () => {
  assert.equal(matchDomainSuffix('x.com', ['x.com']), true);
  assert.equal(matchDomainSuffix('api.x.com', ['x.com']), true);
  assert.equal(matchDomainSuffix('notx.com', ['x.com']), false);
});

test('v1 rejects wildcard and IP literal policies', () => {
  assert.deepEqual(parseDomainSuffixList('*,1.1.1.1,example.com'), ['example.com']);
});
```

Diagnostic target config uses a compact non-secret env string such as `baseline=example.com:443,target-a=example.net:443`; keys must match `[a-z0-9_-]{1,32}` and port must be 1..65535.

- [ ] **Step 2: Run failing tests**

Run: `node --test test/ops/egress-policy.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement pure parsers**

Normalize lower-case FQDNs, strip a terminal dot, reject credentials/URLs/slashes/control characters, reject `*`, and cap each list at 32 suffixes. Keep actual production targets in environment variables, not source defaults.

- [ ] **Step 4: Wire read-only config into `createProxyConfig()`**

Add parsed `diagnosticTargets`, `fallbackDomains` and `forceEgressDomains` to proxy config, but Stage A must set forwarding behavior to direct-only regardless of policy; policy output is available only for observation and later Stage C/D tests.

- [ ] **Step 5: Test and commit**

Run: `node --test test/ops/egress-policy.test.js && npm test && npm run check`
Expected: PASS.

```bash
git add src/ops/egress-policy.js src/config.js src/index.js test/ops/egress-policy.test.js
git commit -m "feat: add bounded egress policy configuration"
```

### Task 6: Observation-only first-byte lifecycle

**Files:**
- Create: `src/ops/egress-diagnostics.js`
- Modify: `src/core/proxy.js`
- Test: `test/core/egress-observation.test.js`

**Interfaces:**
- Produces: `createEgressObserver({targetKey, now, timeoutMs, record})`
- Observer methods: `openOk()`, `openError(error)`, `firstByte()`, `closedBeforeByte()`, `finish()`
- No route changes in Stage A.

- [ ] **Step 1: Write deterministic fake-clock tests**

Test exact event sequence for direct open success + first byte; direct open error; direct close-before-byte; and timeout after 8000 ms. Assert recorded data contains only `{targetKey,event,elapsedMs}` and does not contain hostname, URL, payload or credentials.

- [ ] **Step 2: Run failing test**

Run: `node --test test/core/egress-observation.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement observer with injected clock/timer hooks**

Keep timeout state independent of WebSocket/session idle timer. Timer only emits `direct_first_byte_timeout`; it must not close or reroute the socket in Stage A.

- [ ] **Step 4: Integrate into direct forwarding path**

At target parse time, map hostname to configured diagnostic target key. Only configured keys get observers. Hook open success/error and the first remote chunk/early close in `forwardDataTCP`/`connectStreams`. Use `ctx.waitUntil` or a bounded KV/counter writer only if existing request context supports it; otherwise write sampled `console.log` structured events without arbitrary target strings.

- [ ] **Step 5: Run regression suite and commit**

Run: `node --test test/core/egress-observation.test.js && npm test && npm run check`
Expected: PASS and existing tunnel tests remain green.

```bash
git add src/ops/egress-diagnostics.js src/core/proxy.js test/core/egress-observation.test.js
git commit -m "feat: observe direct egress first-byte failures"
```

### Task 7: Synthetic egress diagnostic endpoint, direct-only contract

**Files:**
- Modify: `src/ops/egress-diagnostics.js`
- Modify: `src/index.js`
- Test: `test/ops/egress-diagnose-api.test.js`

**Interfaces:**
- Produces: `handleEgressDiagnose(request, env, proxyConfig, deps) -> Promise<Response>`
- Stage A `deps.directDial` implemented; NAS dial reports `not_configured` until Stage C.

- [ ] **Step 1: Write failing API tests**

Test `{target:'baseline'}` resolves only a configured key, arbitrary `{hostname:'127.0.0.1',port:22}` returns 400, unknown target returns 404, and a fake direct dial result produces JSON containing target key + elapsed time but not the configured hostname.

- [ ] **Step 2: Run failing test**

Run: `node --test test/ops/egress-diagnose-api.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement direct socket open probe with hard timeout**

Use the same safe direct connect primitive as the forwarding core through dependency injection; open then immediately close. Do not send application data. Return `nas: {state:'not_configured'}` in Stage A.

- [ ] **Step 4: Test and commit**

Run: `node --test test/ops/egress-diagnose-api.test.js && npm test && npm run check`
Expected: PASS.

```bash
git add src/ops/egress-diagnostics.js src/index.js test/ops/egress-diagnose-api.test.js
git commit -m "feat: add bounded direct egress diagnostics"
```

### Task 8: Deployment wiring and Stage A canary gate

**Files:**
- Modify: `.github/workflows/deploy-cloudflare.yml`
- Modify: `wrangler.toml`
- Modify: `docs/operations/edge-operations.md` (create if absent)
- Test: existing `npm test`, `npm run check`

**Interfaces:**
- New secret: `OPTIMIZER_TOKEN`
- New non-secret vars: `OPTIMIZER_ALLOWED_CIDRS`, `DIAGNOSTIC_TARGETS`, `FALLBACK_DOMAINS`, `FORCE_EGRESS_DOMAINS`, `EGRESS_FIRST_BYTE_TIMEOUT_MS`

- [ ] **Step 1: Add `OPTIMIZER_TOKEN` to Wrangler secret upload**

The workflow must fail deployment when the secret is absent/empty; do not use ADMIN/UUID fallback.

- [ ] **Step 2: Add safe production defaults**

`FALLBACK_DOMAINS=""`, `FORCE_EGRESS_DOMAINS=""`, `EGRESS_FIRST_BYTE_TIMEOUT_MS="8000"`. Keep actual diagnostic target names/hostnames in GitHub environment configuration or generated deployment config, not committed examples.

- [ ] **Step 3: Document Stage A manual acceptance**

Document exact checks: unauthenticated `/ops/*` -> 401, browser ADMIN credential does not authorize `/ops/*`, machine token does not authorize `/admin/*`, probe body is 65536 bytes, stale publish -> 409/no `ADD.txt` change, rollback works, and real diagnostic sessions remain direct-only.

- [ ] **Step 4: Run full verification**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy-cloudflare.yml wrangler.toml docs/operations/edge-operations.md
git commit -m "ops: wire Stage A optimizer diagnostics"
```

## Stage A Exit Gate

Do not begin Stage B/C until all conditions hold:

- Source tests/checks pass.
- `/ops/*` auth is isolated from browser admin auth.
- Pool revision/rollback behavior is verified against a non-production fixture KV or controlled canary.
- No fallback or force-egress production rules are enabled.
- Observation mode records only configured target keys and bounded event metadata.
- A direct-only baseline target remains functional through the real client.
