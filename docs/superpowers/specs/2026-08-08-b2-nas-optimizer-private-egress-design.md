# B2 NAS optimizer and private egress design

Date: 2026-08-08
Status: approved design, implementation not started

## 1. Goal

Extend the production `edge.tianbufu.click` deployment with two independent capabilities:

1. A NAS-hosted Cloudflare ingress optimizer that continuously curates the `ADD.txt` pool from the real client-side network.
2. A selective private NAS egress path for destination domains where the Worker's normal direct TCP path fails or produces no upstream data.

The two capabilities are deliberately decoupled. Ingress optimization must never be treated as a fix for Worker-to-destination failures, and the NAS egress path must not become the default route for traffic that already works directly.

Current observed baseline:

- Google works through the imported subscription.
- Instagram works through the imported subscription.
- X/Twitter and JavDB remain in a continuous loading state without a useful client-side error.

That symptom is evidence of a destination-specific path problem, but it is not yet a proven root cause. Implementation must add diagnostics before claiming that Cloudflare direct egress is the cause.

## 2. Existing repository behavior to preserve

The current subscription path already treats KV `ADD.txt` as the operator-controlled ingress address pool. When `ADD.txt` contains entries, subscription generation expands those entries into VLESS/Trojan nodes using `edge.tianbufu.click` as Host/SNI. If the file is empty, the Worker falls back to generated Cloudflare addresses.

The current Worker also already has outbound abstractions for direct TCP and optional SOCKS5/HTTP-style upstream proxies. B2 should reuse and refactor these primitives rather than introduce an unrelated proxy stack.

The production deployment remains:

- Worker: `tianbufu-edge`
- Custom Domain: `edge.tianbufu.click`
- KV namespace: `tianbufu-edge-production`
- KV binding: `KV`
- Public `workers.dev`: disabled

## 3. Architecture

```text
                            NAS
                 +-----------------------+
                 | ingress optimizer     |
                 |                       |
                 | sample -> probe       |
                 | score -> hysteresis   |
                 | publish -> verify     |
                 +-----------+-----------+
                             |
                             | authenticated machine API
                             v
                        Worker KV
                         ADD.txt
                             |
                             v
Client -> selected Cloudflare ingress -> edge.tianbufu.click
                                      |
                                      v
                                Cloudflare Worker
                                      |
                      +---------------+----------------+
                      |                                |
                normal destination              fallback-eligible
                      |                                |
                   direct                         direct first
                      |                                |
                      v                         error / early close /
              Google / Instagram               first-byte timeout
                                                       |
                                                       v
                                                Workers VPC Network
                                                       |
                                                dedicated Tunnel
                                                       |
                                                       v
                                               NAS SOCKS5 egress
                                                       |
                                                       v
                                               target destination
```

The NAS must not expose a SOCKS5 or HTTP CONNECT listener on the public Internet.

## 4. Subsystem A: NAS ingress optimizer

### 4.1 Scope

Version 1 optimizes only Cloudflare IPv4 ingress candidates on TCP 443 for `edge.tianbufu.click`.

IPv6, alternate Cloudflare TLS ports, multi-ISP profiles, and public third-party "preferred IP" feeds are explicitly outside the first implementation. They can be added later without changing the publisher contract.

### 4.2 Candidate sources

Each optimization cycle builds a candidate set from three sources:

1. Every address in the current production Top-N pool.
2. Operator-owned seed addresses from a local configuration file.
3. Randomly sampled addresses from Cloudflare's official IPv4 ranges.

Third-party address feeds are not trusted as an automatic source.

The default cycle sizes are:

- Fast cycle every 6 hours: approximately 64 candidates.
- Full cycle once per day: approximately 192 candidates.

Current winners are always re-tested so a newly sampled pool cannot replace them merely because they were omitted from sampling.

### 4.3 Probe semantics

A probe must measure the route that the subscription will actually use. It therefore connects to the candidate IP while using:

- TLS SNI: `edge.tianbufu.click`
- HTTP Host: `edge.tianbufu.click`
- Port: `443`

The optimizer must not benchmark a candidate by requesting the IP as an IP-literal HTTPS origin.

Each candidate receives three short probe rounds. At minimum the probe records:

- TCP connect success and connect duration.
- TLS handshake success and application-connect duration.
- HTTP status from an authenticated, bounded optimizer probe endpoint.
- Time to first byte.
- Total request duration.
- Response bytes for a small bounded payload, allowing a low-cost throughput estimate.

A certificate validation failure is a hard failure.

The Worker optimizer probe endpoint must cap the response payload to 64 KiB. It exists only to measure the ingress path and must not proxy or fetch arbitrary URLs.

### 4.4 Eligibility and scoring

A candidate is eligible only if:

- At least 2 of 3 rounds succeed.
- TLS certificate verification succeeds.
- The HTTP probe reaches the Worker successfully.
- Median time to first byte is below a configurable hard ceiling, default 1500 ms.

Eligible candidates receive a relative composite score across the current cycle:

- 45% reliability / success rate.
- 25% median time to first byte.
- 15% tail stability using p95 total duration.
- 15% bounded throughput estimate.

Lower latency and tail duration are converted to higher percentile scores before weighting. Exact raw millisecond scales therefore do not dominate the score across different access networks.

Tie-breaking favors addresses already present in the current production pool.

### 4.5 Top-N and diversity

Default production pool size: 8.

Selection constraints:

- Maximum 2 addresses from the same IPv4 `/24`.
- All published optimizer-managed entries use port 443.
- No duplicate IPs.
- Published labels include rank and a short profile label, but never credentials.

The machine publisher rejects pools that violate these constraints.

### 4.6 Hysteresis

A new pool does not replace the production pool merely because its score is slightly better.

Promotion occurs only when all safety gates pass and either:

- The current pool is unhealthy, or
- The new pool's median composite score improves by at least 15% over the current pool.

If fewer than 4 eligible candidates remain, the optimizer must not publish a new pool. It retains the last known good pool and emits a failed-cycle result.

### 4.7 State on NAS

The optimizer persists state under a configurable data directory, default `/data` inside the container:

```text
/data/
  current.json
  previous.json
  last-good-add.txt
  candidates.json
  history.jsonl
  runs/<run-id>.json
```

`history.jsonl` stores cycle summaries, not secrets. Individual run files may contain candidate metrics and are bounded by retention policy.

Default retention:

- Detailed runs: 30 days.
- Cycle summaries: 180 days.

## 5. Optimizer machine API

### 5.1 Authentication

The NAS does not receive the Cloudflare deployment API token.

A new Worker secret named `OPTIMIZER_TOKEN` authenticates a narrowly scoped machine API using:

```text
Authorization: Bearer <OPTIMIZER_TOKEN>
```

Token comparison must avoid obvious timing leaks. The token is independent of `ADMIN` and `UUID` and grants no browser-admin privileges.

### 5.2 Endpoints

Versioned endpoints:

```text
GET  /ops/optimizer/v1/probe
PUT  /ops/optimizer/v1/pool
POST /ops/optimizer/v1/rollback
GET  /ops/optimizer/v1/status
```

`probe` returns only a bounded deterministic payload and basic probe metadata. It never fetches a caller-supplied destination.

`pool` accepts structured JSON rather than raw arbitrary `ADD.txt` text. The server validates every entry before deriving and writing `ADD.txt`.

### 5.3 Publisher validation

The machine API accepts at most 16 entries and enforces the v1 optimizer policy:

- IPv4 only.
- Address must belong to the configured official Cloudflare IPv4 ranges.
- Port must equal 443.
- No duplicate IP.
- Maximum 2 entries per `/24`.
- Entry labels have bounded length and control characters are rejected.
- Request body has a small fixed maximum size.

These constraints ensure that compromise of `OPTIMIZER_TOKEN` cannot silently turn subscription addresses into arbitrary third-party ingress hosts.

The existing authenticated browser-admin `ADD.txt` workflow remains available for deliberate manual overrides and is not constrained to the optimizer's v1 policy.

### 5.4 Versioning and rollback

A publish operation stores a versioned pool snapshot before changing production `ADD.txt`.

Logical KV records:

```text
optimizer:pool:<revision>
optimizer:current
optimizer:previous
optimizer:status
ADD.txt
```

`optimizer:current` and `optimizer:previous` contain revision identifiers. `ADD.txt` remains the compatibility materialization consumed by the existing subscription code.

Publish order:

1. Validate request.
2. Store immutable revision snapshot.
3. Move current revision to previous.
4. Set current revision.
5. Materialize validated entries to `ADD.txt`.
6. Return revision and checksum.

The NAS then verifies the subscription path. If post-publish verification fails, it calls the rollback endpoint, which rematerializes the previous known-good revision.

## 6. Subsystem B: selective private NAS egress

### 6.1 Workers VPC transport

B2 uses a Workers VPC Network binding associated with a dedicated Cloudflare Tunnel that terminates on the NAS egress Docker network.

Workers VPC is currently beta. The implementation must therefore isolate the VPC-specific dialer behind an interface so a future Cloudflare API change or a deliberate migration to a conventional upstream proxy does not require rewriting the forwarding core.

The VPC Network `connect()` path is used only to reach the private NAS SOCKS5 service. Target-site TLS remains end-to-end between the tunnel protocol client and the destination through the SOCKS5 connection; the VPC path is not used as a TLS terminator.

Operational prerequisites:

- Dedicated Cloudflare Tunnel for NAS egress.
- `cloudflared` 2025.7.0 or newer.
- QUIC transport enabled (`auto` or `quic`).
- Outbound UDP/7844 permitted from the NAS where required.
- Required Cloudflare Connectivity Directory permissions for creating/binding the VPC Network.

### 6.2 NAS Docker isolation

The NAS deployment contains at least:

```text
cloudflared
nas-egress
edge-optimizer
```

`nas-egress` exposes its SOCKS5 listener only on an internal Docker network. The compose file must not publish that port on the NAS host.

A dedicated Tunnel is preferred over reusing an unrelated NAS Tunnel so the VPC binding's reachable private surface remains narrow and auditable.

### 6.3 Dialer abstraction

Outbound connection code is refactored around a small dialer contract:

```text
dial(targetHost, targetPort) -> socket
```

Implementations:

- `directDialer`: current `cloudflare:sockets connect()` behavior.
- `nasEgressDialer`: VPC-connect to the private NAS SOCKS5 listener, complete the SOCKS5 handshake, then return a socket connected to the requested destination.

Existing SOCKS5 protocol logic should be reused where practical by injecting the underlying socket/dial function instead of duplicating the handshake implementation.

### 6.4 Domain policy

Default policy is `direct`.

Two explicit suffix-based lists are supported:

- `fallback_domains`: try direct first, then NAS egress on a defined failure condition.
- `force_egress_domains`: skip direct and use NAS egress immediately.

Rules are domain suffix matches with label-boundary semantics. For example, a rule for `x.com` matches `x.com` and `api.x.com`, but not `notx.com`.

IP-literal destinations do not match domain fallback rules in v1.

A global wildcard is not supported in v1. B2 must not accidentally become an all-traffic NAS relay.

Initial production policy is created only after diagnostics. X/Twitter and JavDB are diagnostic candidates, not hard-coded assumptions in the forwarding library.

### 6.5 Fallback conditions

For a `fallback_domains` target, NAS egress is attempted when the direct path has one of these conditions:

1. TCP open throws or times out.
2. Direct socket closes before any upstream response data arrives.
3. No first upstream byte is observed within 8 seconds after the initial client payload is written.

The first-byte timeout is intentionally much shorter than the existing session idle timeout so a broken direct path does not present as an indefinite page spinner.

Once upstream response bytes have been forwarded to the client, the implementation must not silently switch the same stream to NAS egress. Mid-stream route changes can corrupt application protocols and are outside v1.

### 6.6 Failure behavior

If NAS egress is unavailable:

- Normal/direct-only destinations are unaffected.
- Fallback destinations retain their direct attempt and fail normally if both paths fail.
- Force-egress destinations fail closed; they must not unexpectedly fall back to direct.

The NAS being offline must therefore not break Google/Instagram or other direct-only traffic.

## 7. Egress diagnostics

### 7.1 Purpose

Diagnostics exist to establish root cause before adding domains to production fallback policy.

An authenticated endpoint compares the direct and NAS egress paths for a fixed allowlist of diagnostic targets.

Conceptual endpoint:

```text
POST /ops/egress/v1/diagnose
```

The request selects a named target key, not an arbitrary hostname or port.

Configuration example:

```text
google = google.com:443
x = x.com:443
javdb = <operator-approved-current-hostname>:443
```

### 7.2 Output

Diagnostic output includes only connection metadata such as:

- target key and configured hostname/port.
- direct connect success/error and elapsed time.
- direct first-byte result when a safe deterministic request exists.
- NAS egress connect success/error and elapsed time.
- selected recommended policy: direct, fallback candidate, or unresolved.

The endpoint must not become an SSRF primitive or generic port scanner. Caller-supplied target hosts, target ports, request payloads, and URLs are rejected.

### 7.3 Logging

Normal proxy sessions do not add destination logging as part of B2.

Diagnostic events may log the configured target key, path result, and timing, but not arbitrary browsing history or proxy payloads.

## 8. NAS optimizer scheduling

The optimizer container supports both one-shot and scheduler operation:

```text
optimizer run --mode fast
optimizer run --mode full
optimizer daemon
```

Default daemon cadence:

- Fast cycle every 6 hours.
- Full cycle daily.

The Docker deployment must also permit operators to disable the internal scheduler and invoke one-shot runs from NAS cron/task scheduler instead.

Only one optimizer cycle may publish at a time. The process uses a local lock and a server-side expected-current revision check to prevent concurrent stale publishers.

## 9. Configuration and secrets

### Worker secrets

- `ADMIN` — existing browser-admin credential.
- `UUID` — existing tunnel credential.
- `OPTIMIZER_TOKEN` — new machine-only optimizer/diagnostic credential.

### Non-secret Worker configuration

Expected new settings include:

- optimizer probe enablement and fixed payload size.
- VPC binding name.
- NAS egress private address and port.
- fallback domain suffix list.
- force-egress domain suffix list.
- diagnostic target allowlist.
- first-byte fallback timeout.

No Cloudflare account API token, Global API Key, Tunnel token, or NAS secret is committed to the repository.

### NAS secrets

The optimizer receives only:

- `OPTIMIZER_TOKEN`.
- production Worker base URL.

The Cloudflare Tunnel credential is stored separately for `cloudflared` and is not passed into the optimizer container.

## 10. Testing strategy

### 10.1 Unit tests

At minimum cover:

- Cloudflare candidate-range membership validation.
- `/24` diversity enforcement.
- candidate scoring and stable tie-breaking.
- 15% hysteresis gate.
- insufficient-healthy-candidate no-publish behavior.
- machine-token authentication.
- pool revision and rollback semantics.
- domain suffix matching and boundary cases.
- direct/fallback/force policy resolution.
- first-byte timeout state transition.
- no fallback after response bytes have already been forwarded.
- NAS SOCKS5 handshake over injected VPC dialer.

### 10.2 Integration tests

Use local mock TCP servers to simulate:

- direct success.
- direct open failure followed by NAS success.
- direct connection with no first byte followed by NAS success.
- direct success with bytes, proving no mid-stream fallback occurs.
- NAS unavailable.
- force-egress unavailable.

Optimizer integration tests use deterministic mock candidate metrics and a mock publisher API; CI must not benchmark random Internet Cloudflare addresses.

### 10.3 Production canary

Before adding production fallback domains:

1. Deploy diagnostics and VPC/NAS egress with no fallback policy enabled.
2. Confirm Google direct baseline remains healthy.
3. Compare direct versus NAS results for X and the current JavDB hostname.
4. Add only targets for which evidence shows NAS egress materially resolves the failure.
5. Verify actual client page loading through the imported subscription.

## 11. Observability

Optimizer run summary records:

- run ID and mode.
- candidate count.
- eligible count.
- current and proposed pool revisions.
- promotion/no-promotion reason.
- aggregate latency and reliability statistics.

Worker egress metrics should use bounded counters/log samples for:

- direct attempt success/failure.
- first-byte timeout count.
- NAS fallback attempt/success/failure.
- force-egress attempt/success/failure.

Do not log tunnel credentials, optimizer tokens, full proxy URLs, or arbitrary destination payloads.

## 12. Deployment sequence

Implementation and rollout are intentionally staged:

### Stage A — diagnostics and contracts

- Machine auth.
- Optimizer probe endpoint.
- Pool publisher/version/rollback API.
- Domain-policy parser and egress diagnostics.
- No automatic production ADD update yet.
- No production fallback domains yet.

### Stage B — NAS ingress optimizer

- Optimizer container.
- Candidate sampler/prober/scorer.
- Dry-run reports.
- Controlled publish to `ADD.txt`.
- Verify rollback and last-known-good behavior.

### Stage C — private NAS egress

- Dedicated Cloudflare Tunnel.
- Workers VPC Network binding.
- Internal-only NAS SOCKS5 egress.
- Direct/NAS diagnostic comparison.

### Stage D — selective production fallback

- Add evidence-backed fallback domains.
- Validate X/JavDB behavior from the real client.
- Keep known-good destinations direct.

Stages must be independently revertible.

## 13. Rollback

### Ingress optimizer rollback

- Disable optimizer scheduler.
- `POST /ops/optimizer/v1/rollback` to restore the previous pool.
- Existing subscriptions continue using the last materialized `ADD.txt` if the NAS is offline.

### Egress rollback

- Empty fallback and force-egress domain lists to restore all-direct behavior without removing VPC infrastructure.
- If required, deploy the prior Worker version through the existing Cloudflare deployment history.
- Stopping the NAS egress containers must not affect direct-only destinations.

## 14. Security invariants

The implementation is not acceptable unless all of these remain true:

1. No public NAS SOCKS5/CONNECT listener.
2. No Cloudflare account API token on the NAS optimizer.
3. `OPTIMIZER_TOKEN` cannot access browser-admin endpoints.
4. Optimizer publisher can publish only validated Cloudflare IPv4:443 candidates.
5. Diagnostics cannot target arbitrary hosts or ports.
6. NAS egress is not a default global route.
7. Existing direct traffic remains independent of NAS availability.
8. Production fallback domains are added only after diagnostic evidence.
9. Optimizer failure cannot erase a last-known-good `ADD.txt` pool.
10. No new browsing-destination logging is introduced for normal sessions.

## 15. Acceptance criteria

B2 is complete only when all of the following are demonstrated:

### Ingress

- A NAS full cycle measures a bounded candidate set and selects an eligible Top-8 pool.
- Pool entries obey `/24` diversity and Cloudflare IPv4:443 validation.
- The optimizer can publish a new revision through the machine API.
- Subscription generation reflects the new `ADD.txt` pool.
- A failed optimization cycle leaves the previous pool untouched.
- Explicit rollback restores the prior pool.

### Egress

- NAS SOCKS5 has no host/public port mapping.
- Worker reaches it only through the private Workers VPC/Tunnel path.
- Google and Instagram continue to work directly.
- Diagnostics compare direct and NAS paths for X and the current JavDB hostname.
- Any domain added to fallback policy demonstrably loads through the real client after the change.
- NAS shutdown does not break direct-only destinations.

### Operations

- NAS deployment is reproducible with repository-provided Docker Compose/config templates.
- Secrets are documented but never committed.
- Fast/full optimizer schedules are documented.
- Run history and last-known-good state survive container restart.
- Unit and integration tests pass in CI without depending on live random Internet benchmarks.

## 16. Non-goals for B2 v1

- Global all-traffic routing through the NAS.
- Publicly exposed NAS proxy ports.
- Optimizing multiple ISPs or mobile networks in one deployment.
- IPv6 ingress optimization.
- Alternate Cloudflare TLS ports.
- Automatically consuming third-party preferred-IP or ProxyIP feeds.
- Mid-stream route migration after response bytes have begun.
- Arbitrary remote network diagnostics.
- Replacing the existing client-side `url-test` / health-check functionality.
- Proving in advance that X or JavDB failures have one specific Cloudflare root cause; the diagnostics stage must establish that evidence first.
