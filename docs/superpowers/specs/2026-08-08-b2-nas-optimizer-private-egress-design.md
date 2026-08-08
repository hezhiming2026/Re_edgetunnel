# B2 NAS optimizer and private egress design

Date: 2026-08-08
Status: approved design, implementation not started

## 1. Goal

Extend the production `edge.tianbufu.click` deployment with two independent capabilities:

1. A NAS-hosted Cloudflare ingress optimizer that continuously curates the `ADD.txt` pool from the real client-side network.
2. A selective private NAS egress path for destination domains where the Worker's normal direct TCP path fails, closes without response data, or reaches a first-byte timeout.

The two capabilities are intentionally decoupled. Ingress optimization must never be treated as a fix for Worker-to-destination failures, and NAS egress must not become the default route for traffic that already works directly.

Observed baseline before B2:

- Google works through the imported subscription.
- Instagram works through the imported subscription.
- X/Twitter and JavDB remain in a continuous loading state without a useful client-side error.

This is evidence of a destination-specific path problem, not proof of one specific root cause. B2 must add observation-first diagnostics before enabling production fallback domains.

## 2. Existing behavior to preserve

The current subscription path already treats KV `ADD.txt` as the operator-controlled ingress pool. When entries exist, subscription generation expands them into VLESS/Trojan nodes using `edge.tianbufu.click` as Host/SNI. If the file is empty, the Worker falls back to generated Cloudflare addresses.

The current forwarding core already supports direct TCP plus optional SOCKS5/HTTP-style upstream proxies. B2 must reuse/refactor those primitives instead of introducing a second unrelated forwarding stack.

Production resources remain:

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
                 | sample -> probe       |
                 | score -> hysteresis   |
                 | publish -> verify     |
                 +-----------+-----------+
                             |
                             | machine API
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
                direct-only target              fallback-eligible
                      |                                |
                   direct                         direct first
                      |                                |
                      v                         open error / close /
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

The NAS must not expose SOCKS5 or HTTP CONNECT on a public or NAS-host interface.

## 4. Subsystem A — NAS ingress optimizer

### 4.1 V1 scope

V1 optimizes only Cloudflare IPv4 ingress candidates on TCP 443 for `edge.tianbufu.click`.

Out of scope for v1:

- IPv6.
- Alternate Cloudflare TLS ports.
- Multiple ISP/mobile profiles in one optimizer instance.
- Automatic third-party preferred-IP feeds.

### 4.2 Candidate sources

Every cycle combines:

1. All current production Top-N addresses.
2. Operator-owned local seed addresses.
3. Random samples from Cloudflare official IPv4 ranges.

The optimizer keeps a cached last-known-good official CIDR set and must not replace it with an empty/invalid remote fetch. The Worker publisher uses a repository-controlled allowed-CIDR list for independent server-side validation.

Default cycle sizes:

- Fast cycle every 6 hours: about 64 candidates.
- Full cycle daily: about 192 candidates.

Current winners are always re-tested in the same cycle used for promotion decisions.

### 4.3 Probe semantics

The optimizer measures the path the subscription actually uses:

- TCP destination: candidate IPv4.
- Port: 443.
- TLS SNI: `edge.tianbufu.click`.
- HTTP Host: `edge.tianbufu.click`.

It must not benchmark an IP-literal HTTPS origin.

Each candidate receives three short rounds recording at least:

- TCP connect success/duration.
- TLS handshake success/application-connect duration.
- Worker probe HTTP status.
- Time to first byte.
- Total duration.
- Bytes received from a small deterministic payload.

Certificate validation failure is a hard failure.

`GET /ops/optimizer/v1/probe` is authenticated and returns a fixed 64 KiB deterministic payload plus minimal metadata. It never fetches caller-supplied URLs and does not proxy arbitrary content.

### 4.4 Eligibility and score

A candidate is eligible only when:

- At least 2 of 3 rounds succeed.
- TLS certificate validation succeeds.
- The Worker probe endpoint is reached successfully.
- Median TTFB is <= 1500 ms by default.

Composite score within the current cycle:

- 45% success rate/reliability.
- 25% median TTFB percentile.
- 15% p95 total-duration percentile.
- 15% bounded-throughput percentile.

Latency/duration use inverse percentile rank so lower values score higher. Ties favor an address already in the current pool.

### 4.5 Top-N and diversity

Default production pool size: 8.

Machine-published pools must satisfy:

- IPv4 only.
- Cloudflare allowed CIDR membership.
- Port 443 only.
- No duplicate IPs.
- Maximum 2 addresses per IPv4 `/24`.
- Maximum 16 submitted entries.
- Bounded labels without control characters.

### 4.6 Promotion and hysteresis

A new pool is publishable only if it contains at least 4 eligible candidates.

The current Top-8 is defined as **unhealthy** when fewer than 4 of its entries remain eligible during the same comparison cycle.

Promotion occurs only when all validation gates pass and either:

- the current pool is unhealthy, or
- the proposed pool's median composite score is at least 15% better than the current pool's median score.

If the safety gates fail, the optimizer records a failed/no-promotion cycle and leaves production `ADD.txt` untouched.

### 4.7 NAS state

Default persistent state:

```text
/data/
  current.json
  previous.json
  last-good-add.txt
  candidates.json
  history.jsonl
  runs/<run-id>.json
```

Default retention:

- Detailed run files: 30 days.
- Cycle summaries: 180 days.

Secrets are never written into run/history files.

## 5. Optimizer machine API

### 5.1 Authentication boundary

The NAS optimizer does not receive the Cloudflare deployment API token.

A new Worker secret `OPTIMIZER_TOKEN` authenticates only `/ops/optimizer/*` and `/ops/egress/*` machine endpoints:

```text
Authorization: Bearer <OPTIMIZER_TOKEN>
```

Comparison must be timing-resistant. The token is independent from `ADMIN` and `UUID` and cannot authorize browser-admin routes.

### 5.2 Endpoints

```text
GET  /ops/optimizer/v1/probe
PUT  /ops/optimizer/v1/pool
POST /ops/optimizer/v1/rollback
GET  /ops/optimizer/v1/status
POST /ops/egress/v1/diagnose
```

`pool` accepts structured JSON, not arbitrary raw `ADD.txt`.

### 5.3 Optimistic concurrency

Every publish request includes:

```text
expected_current_revision
```

If it does not match Worker KV `optimizer:current`, the Worker returns HTTP 409 and performs no mutation. Rollback also requires the caller's expected current revision.

This prevents overlapping NAS jobs or stale retry requests from overwriting a newer pool.

### 5.4 KV version model

Logical keys:

```text
optimizer:pool:<revision>
optimizer:current
optimizer:previous
optimizer:status
ADD.txt
```

Publish order:

1. Authenticate and validate the entire request.
2. Verify `expected_current_revision`.
3. Write an immutable version snapshot.
4. Move prior current revision to `optimizer:previous`.
5. Set `optimizer:current`.
6. Materialize the validated pool to compatibility key `ADD.txt`.
7. Return revision and checksum.

The NAS then verifies subscription materialization. On post-publish failure it invokes rollback, which rematerializes the previous known-good snapshot.

The existing browser-admin `ADD.txt` editor remains available as an explicit manual override and is not constrained to the optimizer's v1 automatic policy.

## 6. Subsystem B — selective private NAS egress

### 6.1 Workers VPC transport

B2 uses a Workers VPC Network binding associated with a dedicated Cloudflare Tunnel terminating on the NAS egress Docker network.

Workers VPC is beta. VPC-specific connection logic must therefore live behind a dialer interface so a future Cloudflare API change, or migration to a conventional private upstream proxy, does not require rewriting the forwarding core.

The VPC Network `connect()` path reaches only the private NAS SOCKS5 listener. It is plaintext TCP to the private service; the end destination's TLS/application bytes continue through the SOCKS5 tunnel unchanged.

Operational prerequisites:

- Dedicated Cloudflare Tunnel for NAS egress.
- `cloudflared` >= 2025.7.0.
- Tunnel transport `auto` or `quic`.
- Outbound UDP/7844 allowed where required.
- Required Cloudflare Connectivity Directory permissions for VPC creation/binding.

### 6.2 NAS Docker isolation

NAS stack:

```text
cloudflared
nas-egress
edge-optimizer
```

`nas-egress` listens only on an internal Docker network. Docker Compose must not publish its proxy port to the NAS host.

The egress proxy implementation/image must be repository-owned or pinned by immutable image digest; `latest` tags are not acceptable for production.

A dedicated Cloudflare Tunnel is used instead of an unrelated general NAS Tunnel to keep the reachable private surface narrow.

### 6.3 Dialer abstraction

Forwarding code uses:

```text
dial(targetHost, targetPort) -> socket
```

Implementations:

- `directDialer`: existing `cloudflare:sockets connect()` path.
- `nasEgressDialer`: VPC-connect to the private NAS SOCKS5 service, perform the SOCKS5 handshake for `targetHost:targetPort`, then return the resulting socket.

Existing SOCKS5 protocol code should be reused by injecting the underlying socket/dial function instead of duplicating handshake logic.

### 6.4 Domain routing policy

Default policy is direct.

Two explicit suffix lists are supported:

- `fallback_domains`: direct first, then NAS on a defined pre-response failure.
- `force_egress_domains`: NAS immediately; failure is closed and does not silently fall back to direct.

Suffix matching is label-boundary aware: `x.com` matches `x.com` and `api.x.com`, not `notx.com`.

V1 does not match IP literals and does not support a global `*` wildcard. B2 must not accidentally become a global NAS relay.

X/Twitter and JavDB are initial diagnostic candidates, not hard-coded fallback assumptions in the forwarding library.

### 6.5 Fallback state machine

For `fallback_domains`, NAS fallback is allowed only before any upstream response bytes have been forwarded to the client.

Fallback triggers:

1. Direct TCP open throws or times out.
2. Direct socket closes before any response byte.
3. No first upstream byte arrives within 8 seconds after the initial client payload is written.

After the first upstream response byte has been forwarded, route migration is forbidden for that stream.

If NAS is unavailable:

- direct-only traffic is unaffected;
- fallback traffic fails only after direct and NAS both fail;
- force-egress traffic fails closed.

NAS downtime must not break Google/Instagram or other direct-only destinations.

## 7. Egress diagnostics and root-cause evidence

### 7.1 Synthetic path diagnostic

`POST /ops/egress/v1/diagnose` accepts only a configured **target key**, never an arbitrary hostname/port/URL.

Example configuration:

```text
google -> google.com:443
x      -> x.com:443
javdb  -> <operator-approved-current-hostname>:443
```

The endpoint compares bounded connection-level metadata:

- direct TCP open success/error/time;
- NAS SOCKS5 open success/error/time;
- selected conclusion: direct healthy, NAS path available, or unresolved.

It is not a generic HTTP fetcher or port scanner.

### 7.2 Real proxy observation mode

Because a TCP-open diagnostic cannot prove an application first-byte stall, Stage A also adds observation-only events for configured diagnostic domain keys during real proxy sessions.

Allowed event types are bounded, for example:

```text
direct_open_ok
direct_open_error
direct_closed_before_byte
direct_first_byte_ok
direct_first_byte_timeout
nas_open_ok
nas_open_error
```

Before production fallback is enabled, diagnostic domains still use direct-only forwarding; the Worker records only the named target key, event type, and elapsed timing. It does not record payloads, full URLs, arbitrary browsing destinations, or unconfigured domain names.

Root-cause evidence for X/JavDB requires both:

1. a real-session direct failure/stall event, and
2. a successful private NAS connection path to the same configured target.

Only then is the domain eligible for a fallback canary.

## 8. NAS scheduling

The optimizer supports:

```text
optimizer run --mode fast
optimizer run --mode full
optimizer daemon
```

Defaults:

- fast cycle every 6 hours;
- full cycle daily.

Operators may disable the internal scheduler and invoke one-shot runs from NAS cron/task scheduler.

Only one cycle may publish at once. A local process lock plus Worker `expected_current_revision` enforces this on both sides.

## 9. Configuration and secrets

### Worker secrets

- `ADMIN` — existing browser-admin credential.
- `UUID` — existing tunnel credential.
- `OPTIMIZER_TOKEN` — new machine-only optimizer/diagnostic credential.

### Non-secret Worker configuration

Expected additions:

- allowed Cloudflare optimizer CIDRs;
- VPC binding name;
- NAS egress private address/port;
- `fallback_domains`;
- `force_egress_domains`;
- diagnostic target allowlist;
- first-byte timeout (default 8 s).

No Cloudflare account API token, Global API Key, Tunnel token, or NAS secret is committed.

### NAS secrets

`edge-optimizer` receives only:

- `OPTIMIZER_TOKEN`;
- Worker base URL.

`cloudflared` receives its Tunnel credential separately. The optimizer container does not receive it.

## 10. Testing strategy

### Unit tests

At minimum:

- CIDR membership validation.
- `/24` diversity enforcement.
- score ordering/stable tie-breaking.
- current-pool unhealthy definition.
- 15% hysteresis gate.
- insufficient-candidate no-publish path.
- machine authentication and route scoping.
- `expected_current_revision` conflict -> 409/no mutation.
- revision/rollback semantics.
- domain suffix boundary matching.
- direct/fallback/force resolution.
- first-byte timeout transition.
- no fallback after first response byte.
- SOCKS5 handshake over injected VPC dialer.

### Integration tests

Local deterministic mocks simulate:

- direct success;
- direct open failure -> NAS success;
- direct open/no first byte -> NAS success;
- direct response bytes -> no fallback;
- NAS unavailable;
- force-egress unavailable;
- stale optimizer publisher conflict;
- publish verification failure -> rollback.

CI never benchmarks random live Cloudflare Internet addresses.

### Production canary sequence

1. Deploy machine API, observation-only diagnostics, and private NAS connectivity with no fallback domains.
2. Confirm Google/Instagram remain healthy direct baselines.
3. Generate real-session evidence for X and current JavDB target.
4. Confirm NAS path can open the same configured target.
5. Add one evidence-backed fallback target as canary.
6. Verify actual page loading through the imported subscription.
7. Expand only after the canary passes.

## 11. Observability

Optimizer summary:

- run ID/mode;
- sampled and eligible counts;
- current/proposed revisions;
- promotion/no-promotion reason;
- aggregate reliability/latency statistics.

Bounded Worker egress events/counters:

- direct open success/failure;
- first-byte timeout;
- fallback attempt/success/failure;
- force-egress attempt/success/failure.

Never log tunnel credentials, optimizer tokens, full proxy URLs, arbitrary destination payloads, or normal browsing history.

## 12. Deployment stages

### Stage A — diagnostics and contracts

- machine auth;
- bounded optimizer probe;
- pool publisher/version/rollback API;
- domain policy parser;
- synthetic egress diagnostic;
- real-session observation-only diagnostics;
- no automatic production `ADD.txt` update;
- no production fallback domains.

### Stage B — NAS ingress optimizer

- optimizer container;
- candidate sampler/prober/scorer;
- dry-run reporting;
- controlled pool publish;
- last-known-good and rollback verification.

### Stage C — private NAS egress

- dedicated Cloudflare Tunnel;
- Workers VPC Network binding;
- internal-only SOCKS5 egress;
- direct/NAS diagnostic comparison.

### Stage D — selective production fallback

- add only evidence-backed fallback domains;
- validate X/JavDB from the real client;
- keep known-good destinations direct.

Each stage is independently revertible.

## 13. Rollback

Ingress:

- stop/disable optimizer scheduler;
- restore previous pool through revision-checked rollback;
- if NAS is offline, the last materialized `ADD.txt` remains usable.

Egress:

- empty fallback/force lists to return to all-direct forwarding without deleting VPC infrastructure;
- deploy a prior Worker version if required;
- stopping NAS egress must not affect direct-only traffic.

## 14. Security invariants

Implementation is unacceptable unless all remain true:

1. No public/NAS-host proxy listener.
2. No Cloudflare account API token in `edge-optimizer`.
3. `OPTIMIZER_TOKEN` cannot access browser-admin routes.
4. Automatic publisher accepts only validated Cloudflare IPv4:443 candidates.
5. Diagnostic API cannot target arbitrary hosts/ports/URLs.
6. Normal session logging does not gain arbitrary destination history.
7. NAS egress is never the implicit global default.
8. Direct-only traffic is independent of NAS availability.
9. Fallback domains require diagnostic evidence first.
10. Optimizer failure cannot erase the last-known-good pool.
11. External egress container image is immutable-digest pinned if not repository-owned.

## 15. Acceptance criteria

### Ingress

- NAS full cycle measures a bounded candidate set and selects an eligible Top-8.
- Top-8 satisfies CIDR, 443, duplicate and `/24` diversity gates.
- Revision-checked publish updates `ADD.txt` and subscription output.
- Failed/noisy cycles leave production untouched.
- Explicit rollback restores the previous pool.

### Egress

- NAS SOCKS5 has no host/public port mapping.
- Worker reaches NAS egress only through Workers VPC/Tunnel.
- Google and Instagram remain direct and functional.
- Observation mode produces evidence for X and current JavDB target without logging arbitrary browsing history.
- Any enabled fallback domain demonstrably loads from the real client after the canary.
- NAS shutdown does not break direct-only destinations.

### Operations

- NAS deployment is reproducible from repository Docker Compose/config templates.
- Secrets are documented but never committed.
- Fast/full schedules are documented.
- Run history and last-known-good state survive container restart.
- Unit/integration CI passes without live random Internet benchmarking.

## 16. Non-goals for B2 v1

- Global all-traffic NAS routing.
- Public NAS proxy ports.
- Multi-ISP/mobile optimization in one instance.
- IPv6 ingress optimization.
- Alternate Cloudflare TLS ports.
- Automatic third-party preferred-IP/ProxyIP feeds.
- Mid-stream route migration after response bytes begin.
- Arbitrary remote network diagnostics.
- Replacing client-side `url-test`/health-check selection.
- Assuming in advance that X/JavDB share one Cloudflare root cause.
