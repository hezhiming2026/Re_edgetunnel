# B2 Stage C — Private NAS Egress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private NAS SOCKS5 egress path reachable from the Worker through a Workers VPC Network binding and dedicated Cloudflare Tunnel, while keeping production routing direct-only until diagnostics prove benefit.

**Architecture:** The Worker gets a `NAS_VPC` binding and a `nasEgressDialer` that first opens plaintext TCP to an internal NAS SOCKS5 listener via `env.NAS_VPC.connect({hostname,port})`, then performs SOCKS5 CONNECT to the requested destination. Stage C wires diagnostics to compare direct and NAS paths but does not yet enable production fallback lists.

**Tech Stack:** Cloudflare Workers VPC Network binding (beta), Cloudflare Tunnel, Worker Web Streams sockets, existing SOCKS5 protocol code, Docker Compose, pinned lightweight SOCKS5 service.

## Global Constraints

- Workers VPC is beta; VPC-specific code stays behind a dialer interface.
- VPC `connect()` is plaintext TCP to the private NAS service; target TLS remains end-to-end through SOCKS5.
- Dedicated Cloudflare Tunnel; direct tunnel binding requires Connectivity Directory Admin.
- NAS SOCKS5 must have no public or host port mapping.
- External proxy image must be immutable-digest pinned unless repository-owned.
- Google/Instagram and all direct-only traffic must remain independent of NAS availability.
- No production `fallback_domains` or `force_egress_domains` are enabled in Stage C.
- New repository examples contain placeholders, not operator-specific identifiers.

---

## File Structure

- Create `src/core/dialers.js` — direct and NAS VPC dialer contracts.
- Modify `src/protocols/socks5.js` — allow SOCKS5 handshake over an injected already-open socket.
- Modify `src/core/proxy.js` — consume dialer abstraction without changing default direct behavior.
- Modify `src/ops/egress-diagnostics.js` — compare direct vs NAS dialers for configured target keys.
- Modify `src/index.js` — expose `env.NAS_VPC` and non-secret NAS private address/port config.
- Modify `scripts/prepare-cloudflare-config.sh` — append VPC binding to generated deployment config only when required env is present.
- Modify `.github/workflows/deploy-cloudflare.yml` — inject `NAS_EGRESS_TUNNEL_ID` without committing it.
- Create `deploy/nas/egress.compose.yml` and `deploy/nas/cloudflared.env.example`.
- Create `docs/operations/nas-private-egress.md`.
- Create tests `test/core/dialers.test.js`, `test/protocols/socks5-injected.test.js`, `test/ops/egress-diagnose-nas.test.js`.

### Task 1: Extract direct dialer interface

**Files:** `src/core/dialers.js`, `src/core/proxy.js`, `test/core/dialers.test.js`

**Interfaces:**
- `createDirectDialer(connectFn) -> { dial(hostname,port): Promise<Socket> }`
- `dialWithTimeout(dialer, hostname, port, timeoutMs) -> Promise<Socket>`

- [ ] Write fake-socket tests proving hostname/port pass through unchanged, timeout closes late socket, and errors preserve safe class/message without credentials.
- [ ] Run focused test; expected FAIL before module exists.
- [ ] Move the current `cloudflare:sockets connect()` + open-timeout logic into the new module without behavior changes.
- [ ] Replace direct call sites in `proxy.js` with injected `directDialer` while retaining current concurrency/racing semantics.
- [ ] Run `npm test && npm run check`; expected no regressions.
- [ ] Commit: `refactor: isolate outbound direct dialer`.

### Task 2: Reuse SOCKS5 handshake over an injected socket

**Files:** `src/protocols/socks5.js`, `test/protocols/socks5-injected.test.js`

**Interfaces:**
- Produce `socks5ConnectOverSocket(socket, targetHost, targetPort, options) -> Promise<Socket>`.
- Existing `socks5Connect(...)` remains compatible and internally composes open-socket + handshake where possible.

- [ ] Create a mock duplex SOCKS5 server test for no-auth CONNECT using a domain target and exact port encoding.
- [ ] Add tests for rejected method, non-zero SOCKS5 reply, truncated reply, timeout, and domain length >255 rejection.
- [ ] Run focused test; expected FAIL.
- [ ] Refactor handshake parser/writer into injected-socket function; do not duplicate credentials or framing logic.
- [ ] Run existing + new protocol tests; expected PASS.
- [ ] Commit: `refactor: support SOCKS5 over injected sockets`.

### Task 3: Implement NAS VPC dialer

**Files:** `src/core/dialers.js`, `test/core/dialers.test.js`

**Interfaces:**
- `createNasEgressDialer({vpcBinding, proxyHost, proxyPort, socksOptions}) -> {dial(targetHost,targetPort)}`

- [ ] Add fake VPC binding test:

```js
const vpc = { connect: async ({hostname,port}) => {
  assert.equal(hostname, '10.20.0.2');
  assert.equal(port, 1080);
  return mockSocksSocket;
}};
```

Assert target `example.com:443` is passed only to SOCKS5 handshake, not to VPC routing.

- [ ] Run focused test; expected FAIL.
- [ ] Implement `await envBinding.connect({hostname: proxyHost, port: proxyPort})`, then `socks5ConnectOverSocket(...)`.
- [ ] Fail closed if binding/host/port unavailable; never silently use public `connect()` to the NAS proxy address.
- [ ] Run tests; expected PASS.
- [ ] Commit: `feat: add private NAS VPC egress dialer`.

### Task 4: Wire NAS path into bounded diagnostics only

**Files:** `src/ops/egress-diagnostics.js`, `src/index.js`, `test/ops/egress-diagnose-nas.test.js`

**Interfaces:**
- Stage A endpoint now returns both `direct` and `nas` connection metadata.

- [ ] Test fake direct fail + NAS success -> conclusion `nas_path_available`; direct success + NAS success -> `direct_healthy`; both fail -> `unresolved`.
- [ ] Assert JSON includes only target key, state/error class, elapsed milliseconds; no hostname/IP/private proxy address.
- [ ] Run focused test; expected FAIL.
- [ ] Wire `createNasEgressDialer` only when `env.NAS_VPC`, `NAS_EGRESS_HOST`, and `NAS_EGRESS_PORT` are configured.
- [ ] Keep real proxy forwarding direct-only regardless of diagnostic result.
- [ ] Run full tests; expected PASS.
- [ ] Commit: `feat: compare direct and private NAS egress`.

### Task 5: Generate VPC binding without committing tunnel ID

**Files:** `scripts/prepare-cloudflare-config.sh`, `.github/workflows/deploy-cloudflare.yml`, `test/scripts/prepare-cloudflare-config.test.mjs`

**Interfaces:**
- Input secret/env: `NAS_EGRESS_TUNNEL_ID`.
- Generated Wrangler block:

```toml
[[vpc_networks]]
binding = "NAS_VPC"
tunnel_id = "<runtime injected UUID>"
remote = true
```

- [ ] Add script test fixture: absent tunnel ID -> no VPC block; valid UUID -> exact block; malformed value -> script exits non-zero before deploy.
- [ ] Run script test; expected FAIL before update.
- [ ] Append binding only to ignored `wrangler.deploy.toml`; keep committed `wrangler.toml` generic.
- [ ] Pass secret from GitHub Actions; never echo its value in logs.
- [ ] Run tests/checks.
- [ ] Commit: `ops: inject private egress VPC binding`.

### Task 6: NAS Docker isolation and dedicated cloudflared path

**Files:** `deploy/nas/egress.compose.yml`, `deploy/nas/cloudflared.env.example`, `docs/operations/nas-private-egress.md`

- [ ] Define two services: `cloudflared-egress` and `nas-egress`; attach both to a dedicated internal Docker network.
- [ ] `nas-egress` has `expose: ["1080"]` but **no `ports:` block**. Bind service itself to container interface only; do not use host networking.
- [ ] `cloudflared-egress` receives its tunnel token/credential separately and uses pinned `cloudflare/cloudflared` version or digest.
- [ ] Choose/pin SOCKS5 image by immutable digest or add a tiny repository-owned implementation; document exact image provenance and update procedure.
- [ ] Run: `docker compose -f deploy/nas/egress.compose.yml config`; inspect output and confirm no host port publication.
- [ ] Add a negative host test in docs: `ss -lnt | grep ':1080'` must show nothing on NAS host after deployment.
- [ ] Commit: `ops: add isolated NAS egress stack`.

### Task 7: Cloudflare/Tunnel/VPC preflight and canary

**Files:** `docs/operations/nas-private-egress.md`

- [ ] Document current platform requirements: Workers VPC beta; VPC Network binding with tunnel ID; Connectivity Directory Admin to bind directly to Tunnel; `cloudflared >=2025.7.0`; QUIC/auto and UDP/7844 where required.
- [ ] Define canary order: deploy NAS stack -> confirm no host SOCKS port -> establish Tunnel -> deploy Worker VPC binding -> call diagnostic baseline -> compare diagnostic target keys -> stop NAS and confirm direct baseline still works.
- [ ] Do **not** add fallback list entries in this stage.
- [ ] Run full repo tests and deployment config generation in dry mode.
- [ ] Commit: `docs: define private egress canary`.

## Stage C Exit Gate

- `env.NAS_VPC.connect({hostname,port})` successfully reaches only the internal NAS proxy service.
- Direct-vs-NAS diagnostics work for configured target keys.
- No public/host SOCKS5 listener exists.
- Stopping NAS egress does not affect direct-only traffic.
- At least one problematic target shows enough evidence to justify Stage D canary, or Stage D is halted with the conclusion that NAS egress does not explain the failure.
