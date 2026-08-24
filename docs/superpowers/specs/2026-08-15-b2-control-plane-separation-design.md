# B2 Control-Plane Separation and Credential Lifecycle Design

Date: 2026-08-15
Updated: 2026-08-24
Status: design review
Scope: design only; no production routing changes

## 1. Problem statement

The current Worker serves tunnel traffic, subscription delivery, browser administration, and machine optimizer operations on one hostname. Tunnel compatibility benefits from a permissive Cloudflare edge posture, while admin and machine-control endpoints benefit from a strict authentication perimeter. Keeping them on the same hostname forces one edge policy to serve conflicting security requirements.

This design separates those responsibilities into independent host roles, keeps the existing ingress optimizer measurement semantics intact, and removes credential fallback relationships that allow one secret to inherit another secret's authority.

Reusable documentation and tests MUST use placeholders. Operator-specific domains, account IDs, tokens, tunnel IDs, NAS addresses, and optimizer seed IPs are not part of the reusable contract.

## 2. Goals

1. Keep tunnel traffic on explicitly registered data-plane hostnames.
2. Keep one canonical data-plane hostname for subscription generation while allowing additional disaster-recovery data-plane hostnames.
3. Keep browser administration on a dedicated admin hostname protected by Cloudflare Access and Worker-side admin authentication.
4. Keep machine mutation/diagnostic APIs on a dedicated ops hostname protected by Cloudflare Access Service Auth and `OPTIMIZER_TOKEN`.
5. Preserve Stage B ingress measurement semantics: candidate IPs are still probed with the canonical data-plane hostname as TLS SNI and HTTP Host.
6. Make ADMIN, UUID, subscription credential, optimizer credential, and Cloudflare API credentials independent and independently rotatable.
7. Remove legacy high-value secret storage and query-string credential handling that no longer serves the B2 architecture.
8. Migrate without breaking existing subscription or tunnel clients.
9. Make host-to-route authorization explicit, pairwise-disjoint, default-deny, and testable.
10. Support a long-lived `workers.dev` disaster-recovery data-plane endpoint without implicitly trusting preview or extra Worker hostnames.

## 3. Non-goals

- Stage C private NAS egress or selective fallback.
- Changing Stage B ingress scoring or current seven-day fixed-seed experiment parameters.
- Kubernetes or microservice decomposition.
- Replacing Durable Object authority.
- Making the data plane dependent on interactive Cloudflare Access.
- Switching production traffic to `workers.dev` during the current fixed-seed measurement window.

## 4. Terminology

### Data plane

The request path that carries user proxy traffic and the bounded ingress measurement endpoint whose Host/SNI must match real client traffic.

### Control plane

Endpoints that inspect or mutate system configuration. It is split into a human admin plane and a machine ops plane.

### Host role allowlist

A configuration mapping from explicitly trusted hostnames to exactly one role. A hostname not explicitly registered has no role and fails closed before route dispatch.

### Canonical edge host

The single hostname emitted into subscription-generated tunnel nodes and used as TLS SNI / HTTP Host when the NAS measures candidate Cloudflare ingress IPs.

### Disaster-recovery data host

An additional registered data-plane hostname, including the production `workers.dev` hostname, that can carry tunnel traffic but gains no admin/ops authority.

## 5. Target architecture

```text
Internet / clients
        |
        +-----------------------+--------------------+--------------------+
        |                       |                    |                    |
 primary data host       workers.dev DR host   ${ADMIN_HOSTNAME}    ${OPS_HOSTNAME}
   data plane                data plane            admin plane           ops plane
        |                       |                    |                    |
 tunnel protocols        tunnel protocols      Cloudflare Access     Cloudflare Access
 bounded probe           bounded probe         human Allow policy     Service Auth policy
        |                       |                    |                    |
 Worker tunnel auth      Worker tunnel auth     Worker ADMIN session   OPTIMIZER_TOKEN
        |                       |                    |                    |
        +-----------------------+--------------------+--------------------+
                                    |
                            Durable Object authority
                                    |
                                KV mirror only
```

One Worker deployment MAY serve all roles. Separation is a hostname + route authorization boundary, not a requirement to create separate Worker services.

## 6. Host configuration contract

The implementation MUST separate:

```text
DATA_PLANE_HOSTS     = all trusted hostnames allowed to carry tunnel/probe traffic
CANONICAL_EDGE_HOST  = the one data-plane hostname emitted into subscriptions and used for ingress probe Host/SNI
ADMIN_HOSTS          = trusted admin-only hostnames
OPS_HOSTS            = trusted machine-control-only hostnames
```

Example reusable shape:

```text
DATA_PLANE_HOSTS=${EDGE_HOSTNAME},${WORKERS_DEV_HOSTNAME}
CANONICAL_EDGE_HOST=${EDGE_HOSTNAME}
ADMIN_HOSTS=${ADMIN_HOSTNAME}
OPS_HOSTS=${OPS_HOSTNAME}
```

### 6.1 Pairwise-disjoint roles

`DATA_PLANE_HOSTS`, `ADMIN_HOSTS`, and `OPS_HOSTS` MUST be pairwise disjoint.

Configuration validation MUST fail closed if any normalized hostname appears in more than one role set.

Examples that MUST be rejected:

```text
DATA_PLANE_HOSTS=edge.example,worker.account.workers.dev
ADMIN_HOSTS=worker.account.workers.dev
```

or:

```text
ADMIN_HOSTS=control.example
OPS_HOSTS=control.example
```

`CANONICAL_EDGE_HOST` MUST be a member of `DATA_PLANE_HOSTS` and therefore MUST NOT be a member of `ADMIN_HOSTS` or `OPS_HOSTS`.

Hostname normalization must be deterministic before overlap checks (lowercase, no port, no trailing dot unless the implementation contract deliberately preserves one canonical form).

### 6.2 Canonical-host switching

The operator may later set:

```text
CANONICAL_EDGE_HOST=${WORKERS_DEV_HOSTNAME}
```

without rotating UUID/tunnel credentials, provided the exact production `workers.dev` hostname is enabled and registered in `DATA_PLANE_HOSTS`.

Changing the canonical host is a client-routing migration, not an authentication migration.

## 7. Host-to-route contract

The Worker MUST classify the request hostname before route dispatch.

### 7.1 Any hostname in `DATA_PLANE_HOSTS`

Allowed:

- tunnel WebSocket traffic;
- gRPC tunnel traffic;
- XHTTP tunnel traffic;
- canonical subscription endpoint;
- benign masquerade/root response;
- exactly one bounded, read-only ingress measurement endpoint described in section 8.

Denied:

- `/admin` and `/admin/*`;
- `/login`, `/logout`;
- all machine mutation/status/diagnostic APIs on `/ops/*`, except that the legacy probe path may be temporarily mapped to the bounded read-only measurement handler during migration if section 8's constraints are preserved;
- future control-plane mutation routes.

### 7.2 Any hostname in `ADMIN_HOSTS`

Allowed:

- `/login`;
- `/logout`;
- `/admin` and `/admin/*`;
- optional `/sub` helper only as redirect to the canonical subscription URL.

Denied:

- all tunnel dispatchers;
- all `/ops/*` routes;
- ingress measurement endpoint.

### 7.3 Any hostname in `OPS_HOSTS`

Allowed:

- `/ops/optimizer/v1/*` machine-control/status operations;
- `/ops/egress/v1/*` diagnostics;
- future narrowly scoped machine endpoints.

Denied:

- browser admin routes;
- subscription rendering;
- all tunnel dispatchers;
- ingress measurement scoring endpoint for candidate-IP latency/eligibility, because measuring the Access-protected ops hostname would not represent client data-plane routing.

### 7.4 Unknown / unregistered hostname

Any hostname outside all three role sets MUST be rejected before route dispatch with non-sensitive 404 or 403 behavior.

This includes stale routes, preview hostnames, accidentally added Custom Domains, renamed/extra `workers.dev` names, and any future routing surface not deliberately assigned a role.

## 8. Preserve Stage B ingress measurement semantics

The NAS optimizer exists to measure:

```text
NAS -> candidate Cloudflare IP:443
TLS SNI = CANONICAL_EDGE_HOST
HTTP Host = CANONICAL_EDGE_HOST
fixed Worker probe response
```

Moving that measurement to `OPS_HOSTNAME` would measure a different hostname and potentially a different Access/WAF edge policy. That is forbidden because changing Stage B measurement semantics is a non-goal.

### 8.1 Bounded data-plane measurement endpoint

The design therefore reserves one exact read-only measurement route on data-plane hosts, for example:

```text
GET /probe/optimizer/v1
```

Implementation MAY retain the existing exact legacy path `GET /ops/optimizer/v1/probe` during migration, but only if it is dispatched as this measurement exception rather than as general `/ops/*` authority. The long-term preferred path is outside `/ops/*` so the control-plane boundary remains obvious.

The measurement handler MUST:

- accept GET only;
- require the existing machine bearer token or an equivalent dedicated probe credential;
- perform no KV or Durable Object mutation;
- perform no outbound fetch/dial;
- return the deterministic fixed 65,536-byte probe contract;
- set `Cache-Control: no-store`;
- expose no control-plane state or secrets;
- be callable through each registered data-plane hostname;
- be tested using candidate IP + `CANONICAL_EDGE_HOST` SNI/Host, exactly matching Stage B intent.

Machine mutation/status calls continue to use `OPS_HOSTS`; only the bounded probe remains on the data plane.

### 8.2 Canonical-host migration and measurements

If `CANONICAL_EDGE_HOST` later switches from a Custom Domain to `workers.dev`, that begins a new measurement baseline. The NAS probe Host/SNI must switch with it only after the current controlled measurement window is complete.

## 9. `workers.dev` disaster-recovery policy

The production `workers.dev` hostname is a first-class long-lived data-plane DR endpoint.

Policy:

1. It may remain enabled continuously.
2. Its exact hostname must be explicitly present in `DATA_PLANE_HOSTS`.
3. It never implicitly gains admin or ops authority.
4. Preview URLs remain untrusted by default.
5. Default recommendation remains:

```text
primary/canonical = operator Custom Domain
disaster recovery = production workers.dev hostname
```

6. The operator may later choose `workers.dev` as `CANONICAL_EDGE_HOST` after a separate migration gate.
7. Such a switch does not rotate UUID.
8. Do not switch canonical host during the current fixed-seed experiment.

## 10. Subscription hostname and credential contract

### 10.1 Canonical subscription output

All generated VLESS/Trojan/SS or other tunnel nodes MUST use `CANONICAL_EDGE_HOST` for endpoint Host/SNI.

The generator MUST NOT derive the tunnel hostname from `request.url.hostname`.

An admin-plane `/sub` helper, if retained, is redirect-only to the canonical data-plane subscription URL.

### 10.2 Independent `SUB_TOKEN`

Introduce an independent random `SUB_TOKEN` (preferred for this single-operator deployment) or a dedicated HMAC secret.

Requirements:

- at least 32 random bytes before encoding;
- constant-time comparison after hashing or equivalent bounded comparison;
- no token value in logs;
- independently rotatable without changing UUID.

### 10.3 Mandatory bounded legacy overlap

Migration from the existing hostname/UUID-derived subscription token MUST use a mandatory read-only overlap period. Immediate cutover with no overlap is not allowed.

During Phase C:

```text
new SUB_TOKEN accepted = yes
legacy subscription token accepted read-only = yes
legacy token may mutate state = no
```

Legacy acceptance may be disabled only after all of the following are true:

1. the new canonical subscription URL using `SUB_TOKEN` has successfully refreshed;
2. every known client has been updated and has successfully refreshed at least once;
3. there has been no required legacy-token use during a configured grace period of at least 24 hours after the last known client migration;
4. the operator explicitly completes the cutover gate.

Tests MUST prove the old token still works read-only during overlap and returns unauthorized only after the explicit retirement condition.

If a client is discovered to have missed migration, rollback re-enables the read-only overlap; UUID remains unchanged.

## 11. Authentication layers

### Data plane

`UUID` is tunnel authentication only. It MUST NOT serve as admin password, subscription-token seed after migration, or optimizer-token fallback.

### Admin plane

Layer 1: Cloudflare Access human policy.

Layer 2: Worker `ADMIN` login/session.

`ADMIN` has no fallback to `PASSWORD`, `TOKEN`, `KEY`, `UUID`, or other aliases.

### Ops plane

Layer 1: Cloudflare Access Service Auth using a dedicated NAS service token.

Layer 2: Worker `OPTIMIZER_TOKEN`.

The Access service token and `OPTIMIZER_TOKEN` are independent credentials. The NAS does not receive a Cloudflare account deployment token merely to call ops APIs.

## 12. Legacy secret surface removal

Unless a concrete use case is proven, remove:

1. Admin query-string Cloudflare Global API Key/API Token handling.
2. Cloudflare high-value credential persistence in KV (`cf.json`).
3. Telegram bot-token persistence in general KV; if Telegram remains, token becomes a Worker secret.
4. Generic admin-password fallback through `PASSWORD`, `TOKEN`, `KEY`, or `UUID`.

## 13. Cloudflare deployment credential separation

Split the current broad Cloudflare token into:

### Worker deploy token

Only permissions required to deploy Worker resources, KV/DO bindings, and Worker secrets.

### Zone security token

Only permissions required for intended hostname-scoped Zone/WAF policy.

Zone security changes become an explicit infrastructure action instead of an implicit mutation on every Worker deployment.

## 14. Migration sequencing without a control-route exception

The final host matrix is absolute: once enforcement is enabled, data-plane hosts do not serve admin or machine-control routes other than the bounded measurement exception.

To migrate without inventing a contradictory temporary role, use sequencing rather than a runtime bypass flag.

### Phase A — code/contracts, enforcement off in production

- implement host-role classifier and configuration validation;
- add pairwise-disjoint role tests;
- add unknown-host tests;
- add canonical subscription-host tests;
- add bounded data-plane probe tests;
- add independent credential tests;
- production routing behavior remains unchanged.

### Phase B — additive hostnames, old behavior still unchanged

- enable/register production `workers.dev` as DR data host;
- add `ADMIN_HOSTNAME` and `OPS_HOSTNAME`;
- configure Access policies;
- verify new admin and ops hostnames while the old single-host behavior still exists exactly as before;
- do not enable the new host-matrix enforcement yet.

This phase is intentionally no worse than the current pre-separation posture; there is no ad-hoc compatibility exception inside the final authorization matrix.

### Phase C — migrate consumers

- move browser admin use to `ADMIN_HOSTNAME`;
- move machine mutation/status API calls to `OPS_HOSTNAME`;
- keep ingress candidate probing against `CANONICAL_EDGE_HOST` via the bounded data-plane probe endpoint;
- enable `SUB_TOKEN` while retaining mandatory read-only legacy overlap;
- update known subscription clients and verify refresh.

### Phase D — atomic enforcement cutover

Only after Phase C evidence is complete:

- enable strict host-role enforcement;
- data-plane admin routes disappear;
- data-plane machine-control routes disappear except the exact measurement endpoint;
- admin and ops host roles become exclusive;
- unknown hosts fail closed.

No compatibility flag may re-enable `/admin` or general `/ops/*` on data-plane hosts after this cutover.

### Phase E — retire legacy secrets and overlap

- disable legacy subscription token only after section 10.3 gates pass;
- remove credential fallback and legacy secret-management surfaces;
- split Cloudflare deployment/security tokens.

### Optional Phase F — canonical host switch

After the current optimizer experiment and a separate ingress baseline decision:

- set `CANONICAL_EDGE_HOST` to the exact production `workers.dev` hostname if desired;
- run tunnel/subscription canaries;
- update NAS probe SNI/Host to the new canonical host;
- treat subsequent measurements as a new baseline;
- retain a Custom Domain as alternate data-plane host where practical.

## 15. Rollback

- Before Phase D, rollback means continuing to use the old single-host behavior while fixing new Access/host configuration.
- After Phase D, rollback restores the previous deployment/configuration as one explicit release; do not selectively reopen control routes on arbitrary data-plane hosts.
- Canonical-host rollback restores the previous `CANONICAL_EDGE_HOST` and corresponding NAS probe Host/SNI.
- Subscription-token rollback re-enables the bounded read-only legacy overlap.
- UUID does not rotate for hostname/control-plane rollback.

## 16. Test and evidence gates

Before implementation can be merged:

1. `DATA_PLANE_HOSTS`, `ADMIN_HOSTS`, and `OPS_HOSTS` are proven pairwise disjoint; overlaps fail configuration validation.
2. `CANONICAL_EDGE_HOST` must belong only to the data-plane role.
3. Unknown/unregistered hosts fail before route dispatch.
4. Admin/ops hostnames cannot start tunnel sessions.
5. Registered Custom Domain and production `workers.dev` data hosts can start tunnel sessions.
6. Subscription output always uses `CANONICAL_EDGE_HOST`.
7. Data-plane candidate probing uses candidate IP + `CANONICAL_EDGE_HOST` TLS SNI/HTTP Host and preserves the fixed 65,536-byte contract.
8. Ops-host Access policy is not used as the ingress measurement path.
9. No credential fallback exists between ADMIN/UUID/SUB/OPTIMIZER roles.
10. Mandatory legacy subscription overlap is tested through migration and explicit retirement.
11. Existing protocol tests remain green.
12. Wrangler dry-run succeeds.
13. Production rollout does not combine hostname migration, Stage C egress, or optimizer scoring changes.

## 17. Decisions frozen by this revision

- One Worker remains the default topology.
- Role sets are pairwise disjoint; a hostname has exactly one role.
- Production `workers.dev` is a long-lived DR data-plane endpoint.
- Default canonical recommendation remains an operator Custom Domain, but `CANONICAL_EDGE_HOST` may later switch to `workers.dev`.
- Unknown hostnames fail closed.
- Generated subscriptions use only `CANONICAL_EDGE_HOST`.
- Stage B candidate-IP probes remain on the data-plane Host/SNI path through one bounded read-only endpoint.
- Migration uses sequencing, not a temporary authorization exception in the final host matrix.
- Legacy subscription-token overlap is mandatory and bounded until client migration is proven.
- Current seven-day fixed-seed experiment is not altered.

## 18. References checked 2026-08-24

- Cloudflare Workers routes and domains: https://developers.cloudflare.com/workers/configuration/routing/
- Cloudflare Workers `workers.dev`: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Cloudflare Workers Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Cloudflare Access for Workers/hostnames: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Cloudflare Access service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

These are implementation dependencies and must be rechecked before production rollout.
