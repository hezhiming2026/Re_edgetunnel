# B2 Control-Plane Separation and Credential Lifecycle Design

Date: 2026-08-15
Updated: 2026-08-24
Status: design review
Scope: design only; no production routing changes

## 1. Problem statement

The current Worker serves tunnel traffic, subscription delivery, browser administration, and machine optimizer operations on one hostname. Tunnel compatibility benefits from a permissive Cloudflare edge posture, while admin and machine-control endpoints benefit from a strict authentication perimeter. Keeping them on the same hostname forces one edge policy to serve conflicting security requirements.

This design separates those responsibilities into independent host roles, preserves Stage B ingress measurement semantics, and removes credential fallback relationships without rotating the currently effective tunnel identity.

Reusable documentation and tests MUST use placeholders. Operator-specific domains, account IDs, tokens, tunnel IDs, NAS addresses, optimizer seeds, and raw measurement data are not part of the reusable contract.

## 2. Goals

1. Keep tunnel traffic on explicitly registered data-plane hostnames.
2. Keep one canonical data-plane hostname for subscription generation while allowing additional disaster-recovery data-plane hostnames.
3. Keep browser administration on dedicated admin hostname(s) protected by Cloudflare Access and Worker-side admin authentication.
4. Keep machine mutation/status/diagnostic APIs on dedicated ops hostname(s) protected by Cloudflare Access Service Auth and `OPTIMIZER_TOKEN`.
5. Preserve Stage B candidate-IP measurement semantics: probe candidate IPs with `CANONICAL_EDGE_HOST` as TLS SNI and HTTP Host.
6. Make ADMIN, UUID, subscription credential, optimizer credential, Access service credentials, and Cloudflare deployment credentials independent and independently rotatable.
7. Remove legacy high-value secret storage and credential fallbacks without breaking existing clients.
8. Make host-to-route authorization explicit, pairwise-disjoint, default-deny, and exhaustively testable.
9. Support a long-lived production `workers.dev` disaster-recovery data-plane endpoint without implicitly trusting preview/extra Worker hostnames.
10. Migrate in bounded stages with explicit rollback gates.

## 3. Non-goals

- Stage C private NAS egress or selective fallback.
- Changing Stage B scoring or the current seven-day fixed-seed experiment.
- Kubernetes or microservice decomposition.
- Replacing Durable Object authority.
- Putting interactive Cloudflare Access in front of the data plane.
- Switching the production canonical hostname during the current optimizer measurement window.
- Implementing the migration in this design-only PR.

## 4. Terminology

### Data plane

The request path that carries user tunnel traffic, subscription delivery, and the bounded ingress probe whose Host/SNI must match client traffic.

### Admin plane

Human control routes protected by Cloudflare Access plus Worker-side `ADMIN` authentication/session controls.

### Ops plane

Machine control/status/diagnostic routes protected by Cloudflare Access Service Auth plus Worker-side `OPTIMIZER_TOKEN`.

### Host role allowlist

A mapping from an explicitly trusted hostname to exactly one role. A hostname with no registered role fails closed before route dispatch.

### Canonical edge host

The single data-plane hostname emitted into generated subscriptions and used as TLS SNI / HTTP Host for candidate-IP ingress probes.

### Effective UUID

The UUID actually accepted by the current production tunnel implementation. It may be explicitly configured or, in legacy deployments, deterministically derived from fallback credentials and `KEY`.

### Credential handoff

A migration in which replacement credentials are provisioned and verified before the superseded credential is explicitly revoked.

## 5. Target architecture

```text
Internet / clients
        |
        +-----------------------+--------------------+--------------------+
        |                       |                    |                    |
 primary data host       workers.dev DR host   ${ADMIN_HOSTNAME}    ${OPS_HOSTNAME}
   data plane                data plane            admin plane           ops plane
        |                       |                    |                    |
 tunnel/sub/probe       tunnel/sub/probe       Cloudflare Access     Cloudflare Access
                                                human Allow           Service Auth
        |                       |                    |                    |
 tunnel UUID            tunnel UUID             ADMIN session       OPTIMIZER_TOKEN
        |                       |                    |                    |
        +-----------------------+--------------------+--------------------+
                                    |
                            Durable Object authority
                                    |
                                KV mirror only
```

One Worker deployment MAY serve all roles. Separation is a hostname + route authorization boundary, not a requirement for separate Worker services.

## 6. Host configuration contract

```text
DATA_PLANE_HOSTS     = trusted tunnel/subscription/probe hostnames
CANONICAL_EDGE_HOST  = one data-plane hostname emitted into subscriptions and used for probe Host/SNI
ADMIN_HOSTS          = trusted admin-only hostnames
OPS_HOSTS            = trusted machine-control-only hostnames
```

Reusable example:

```text
DATA_PLANE_HOSTS=${EDGE_HOSTNAME},${WORKERS_DEV_HOSTNAME}
CANONICAL_EDGE_HOST=${EDGE_HOSTNAME}
ADMIN_HOSTS=${ADMIN_HOSTNAME}
OPS_HOSTS=${OPS_HOSTNAME}
```

### 6.1 Pairwise-disjoint roles

`DATA_PLANE_HOSTS`, `ADMIN_HOSTS`, and `OPS_HOSTS` MUST be pairwise disjoint after deterministic normalization.

Normalization MUST occur before membership/overlap checks and at minimum handles:

- lowercase hostname;
- no port;
- one canonical trailing-dot form.

Configuration validation MUST fail closed when any normalized hostname appears in more than one role set.

`CANONICAL_EDGE_HOST` MUST be a member of `DATA_PLANE_HOSTS` and MUST NOT appear in `ADMIN_HOSTS` or `OPS_HOSTS`.

### 6.2 Canonical host switching

The operator MAY later set:

```text
CANONICAL_EDGE_HOST=${WORKERS_DEV_HOSTNAME}
```

without rotating UUID, provided the exact production `workers.dev` hostname is enabled and registered in `DATA_PLANE_HOSTS`.

A canonical-host switch starts a new ingress-measurement baseline and is a separate migration from control-plane separation.

## 7. Complete host-to-route contract

The Worker MUST classify hostname before any tunnel or sensitive-route dispatch.

The final matrix is:

| Route/capability | DATA | ADMIN | OPS | Unknown |
| --- | --- | --- | --- | --- |
| tunnel WS/gRPC/XHTTP | allow | deny | deny | deny |
| canonical subscription render | allow | deny | deny | deny |
| optional `/sub` compatibility helper | canonical render only | redirect-only to canonical DATA URL | deny | deny |
| `/login`, `/logout`, `/admin/*` | deny | allow | deny | deny |
| general `/ops/*` mutation/status/diagnostics | deny | deny | allow | deny |
| exact bounded ingress probe | allow | deny | deny for scoring | deny |
| benign data masquerade/root | allow | deny unless explicitly required | deny | deny |

The **only** control-looking exception on a data hostname is the exact bounded read-only ingress probe defined in section 8. No prefix-based `/ops/*` authority is inherited from it.

Tests MUST cover every negative cell above, including:

- DATA rejecting login/admin/general ops;
- ADMIN rejecting tunnels/general ops/probe;
- OPS rejecting tunnels/subscription/admin/probe-for-scoring;
- unknown host rejecting everything before dispatch.

A future sensitive route is denied on every role until it is explicitly assigned and tested.

## 8. Preserve Stage B ingress measurement semantics

The optimizer measures:

```text
NAS -> candidate Cloudflare IP:443
TLS SNI = CANONICAL_EDGE_HOST
HTTP Host = CANONICAL_EDGE_HOST
GET exact probe path
fixed deterministic 65,536-byte response
```

Using `OPS_HOSTNAME` for candidate scoring is forbidden because Access/WAF/hostname policy would change the measured path.

### 8.1 Bounded data-plane probe

Reserve one exact read-only route, preferably:

```text
GET /probe/optimizer/v1
```

The current exact legacy path `GET /ops/optimizer/v1/probe` MAY be temporarily mapped to the same bounded handler during migration, but it MUST NOT inherit any other `/ops/*` behavior.

The handler MUST:

- accept GET only;
- require `OPTIMIZER_TOKEN` or an equivalent dedicated probe credential;
- perform no KV/DO mutation;
- perform no outbound fetch/dial;
- return exactly the deterministic 65,536-byte probe contract;
- send `Cache-Control: no-store`;
- expose no control-plane state/secrets;
- work through every registered data-plane hostname;
- be tested by dialing candidate IP + `CANONICAL_EDGE_HOST` SNI/Host.

### 8.2 Separate NAS endpoints and credentials

Control traffic and measurement traffic MUST be configured separately. The implementation contract should expose equivalent settings to:

```text
OPS_BASE_URL=https://${OPS_HOSTNAME}
PROBE_HOST=${CANONICAL_EDGE_HOST}
CF_ACCESS_CLIENT_ID=<secret>
CF_ACCESS_CLIENT_SECRET=<secret>
OPTIMIZER_TOKEN=<secret>
```

Rules:

- status/publish/rollback/egress-diagnostic calls use `OPS_BASE_URL`;
- those ops calls send Cloudflare Access service-token headers **and** Worker `Authorization: Bearer <OPTIMIZER_TOKEN>`;
- candidate probes dial the candidate IP while keeping `PROBE_HOST` as TLS SNI/HTTP Host;
- Access service credentials are never sent to the data-plane probe;
- `WORKER_BASE_URL` MUST NOT remain an ambiguous single setting once the split is activated;
- NAS canaries must test ops and probe paths independently.

Before moving any NAS ops consumer to the Access-protected host, the Access service token MUST already be provisioned, installed on NAS, and verified end-to-end.

## 9. `workers.dev` disaster-recovery policy

The production `workers.dev` hostname is a first-class long-lived DR data-plane endpoint.

1. Its exact production hostname must be explicitly present in `DATA_PLANE_HOSTS` before use.
2. It never implicitly gains admin or ops authority.
3. Preview URLs remain untrusted by default.
4. Default recommendation remains:

```text
primary/canonical = operator Custom Domain
disaster recovery = production workers.dev hostname
```

5. The operator MAY later choose `workers.dev` as `CANONICAL_EDGE_HOST` in a separate migration.
6. Such a switch does not rotate UUID.
7. It MUST NOT be enabled publicly while host-agnostic control routing would still expose `/login`, `/admin/*`, or general `/ops/*` on that hostname.
8. Therefore `workers.dev` is enabled only atomically with data-only role enforcement already active for it. From its first externally reachable request it is a DATA role and nothing else.
9. Do not switch the canonical host during the current fixed-seed experiment.

## 10. Subscription hostname and token contract

### 10.1 Canonical subscription output

All generated tunnel nodes MUST use `CANONICAL_EDGE_HOST` for endpoint Host/SNI. The generator MUST NOT derive the tunnel hostname from `request.url.hostname`.

An admin-plane `/sub` helper, if retained, is redirect-only to the canonical DATA subscription URL.

### 10.2 Independent `SUB_TOKEN`

Introduce an independent random `SUB_TOKEN` (preferred for this single-operator deployment) or dedicated HMAC secret.

Requirements:

- at least 32 random bytes before encoding;
- constant-time comparison after hashing or equivalent bounded comparison;
- no token value in logs;
- independently rotatable without changing UUID.

### 10.3 Mandatory bounded legacy overlap

Migration from hostname/UUID-derived subscription authorization MUST have a read-only overlap. Immediate cutover is forbidden.

```text
new SUB_TOKEN accepted = yes
legacy subscription token accepted read-only = yes
legacy token mutation authority = none
```

Legacy acceptance may be disabled only after:

1. the new canonical subscription URL using `SUB_TOKEN` refreshes successfully;
2. every known client refreshes successfully at least once with the new token;
3. at least 24 hours of grace passes after the last known client migration with no required legacy-token use;
4. the operator explicitly completes the retirement gate.

Rollback may re-enable read-only overlap without changing UUID.

## 11. Credential-role contract

### 11.1 Tunnel UUID

`UUID` authorizes tunnel protocol identity only. It is not an admin password, subscription token, or optimizer token.

### 11.2 Admin credential

Cloudflare Access human policy is layer 1. Worker `ADMIN` session/auth is layer 2.

`ADMIN` has no permanent fallback to `PASSWORD`, `TOKEN`, `KEY`, `UUID`, or other aliases after migration.

### 11.3 Ops credentials

Cloudflare Access Service Auth is layer 1. `OPTIMIZER_TOKEN` is layer 2.

Access service credentials and `OPTIMIZER_TOKEN` are independent and separately revocable. NAS does not receive Worker deployment/zone-management credentials to call ops APIs.

### 11.4 Materialize the current effective UUID before fallback removal

Legacy code may derive the actual tunnel UUID when no valid explicit `UUID` exists. Removing credential fallback/derivation without first preserving that value can rotate or destroy tunnel identity.

Before any code that changes/removes legacy UUID derivation is deployed, the migration MUST:

1. compute the exact effective UUID using the currently deployed production inputs and algorithm;
2. record it as an explicit production `UUID` secret/value without changing its bytes;
3. deploy with the explicit UUID while legacy derivation is still available;
4. verify the effective UUID before/after is identical;
5. verify existing subscription output and at least one real tunnel canary still authenticate with that UUID;
6. only then remove fallback derivation and credential aliases.

If the effective UUID cannot be determined or equality cannot be proven, credential-fallback retirement is blocked.

This migration is **identity materialization**, not UUID rotation.

## 12. Legacy secret surface removal

Unless a concrete use case is proven, remove after migration gates pass:

1. admin query-string Cloudflare Global API Key/API Token handling;
2. Cloudflare high-value credential persistence in KV (`cf.json`);
3. Telegram bot-token persistence in general KV; retained Telegram token becomes a Worker secret;
4. generic admin-password fallback through `PASSWORD`, `TOKEN`, `KEY`, or `UUID`;
5. implicit UUID derivation only after section 11.4 has materialized and verified the existing effective UUID.

## 13. Cloudflare deployment credential separation and revocation

Replace the current broad Cloudflare credential with least-privilege credentials.

### Worker deploy token

Only permissions required to deploy Worker resources and required Worker/KV/DO configuration.

### Zone security token

Only permissions required for intended hostname-scoped Zone/WAF/security policy.

Zone-security mutation becomes an explicit infrastructure action instead of an implicit side effect of every Worker deploy.

### Mandatory handoff

The old broad `CLOUDFLARE_API_TOKEN` or equivalent MUST NOT remain valid indefinitely after the split.

Required sequence:

1. create least-privilege Worker deploy token;
2. create least-privilege zone-security token if needed;
3. update CI/secrets to use each token only for its role;
4. successfully run a Worker deployment validation with the new deploy token;
5. successfully validate the intended zone/security operation with the new zone token;
6. confirm no workflow/runtime path still depends on the old broad token;
7. explicitly revoke/delete the superseded broad token at Cloudflare;
8. record non-secret revocation evidence/time in the rollout report.

Failure to revoke the old broad credential means the least-privilege migration is incomplete.

## 14. Migration sequencing

The final host matrix is absolute. Migration uses sequencing, not a permanent compatibility bypass.

### Phase A — code/contracts only

- implement host-role classifier and pairwise-disjoint validation;
- implement complete host-role-by-sensitive-route negative matrix tests;
- implement canonical subscription host logic;
- implement bounded data-plane probe;
- add strict credential role tests;
- add effective-UUID materialization test/support;
- add split NAS ops/probe configuration support;
- production behavior remains unchanged.

### Phase B — provision control hosts, keep new DR data route disabled

- add/provision `ADMIN_HOSTNAME` and `OPS_HOSTNAME`;
- configure Access human and Service Auth policies;
- provision NAS Access service credentials;
- verify admin host with human Access + Worker admin auth;
- verify ops host with Access service token + `OPTIMIZER_TOKEN`;
- verify separate NAS ops/probe configuration in canary mode;
- **do not enable the production `workers.dev` route yet** while existing host-agnostic routing remains active.

### Phase C — migrate consumers while existing primary host still supports legacy behavior

- move browser admin use to `ADMIN_HOSTNAME`;
- move machine mutation/status calls to `OPS_BASE_URL` using Access service credentials + `OPTIMIZER_TOKEN`;
- keep candidate probing on candidate IP + `CANONICAL_EDGE_HOST` via the bounded DATA probe;
- enable `SUB_TOKEN` with mandatory read-only legacy overlap;
- migrate/verify known subscription clients;
- materialize and verify the current effective UUID as explicit `UUID` before fallback removal.

### Phase D — atomic host-role enforcement and `workers.dev` enablement

After Phase C evidence is complete:

1. deploy strict host-role enforcement for the existing registered roles;
2. verify DATA rejects admin/general ops, ADMIN rejects tunnels/ops, OPS rejects tunnels/admin, and unknown hosts fail closed;
3. only then enable the exact production `workers.dev` hostname with DATA role enforcement already active;
4. canary `workers.dev` tunnel/sub/probe behavior;
5. confirm `workers.dev` rejects login/admin/general ops from its first public availability.

No compatibility flag may reopen `/admin` or general `/ops/*` on a DATA hostname after this cutover.

### Phase E — retire legacy credentials

- disable legacy subscription token only after section 10.3 gates pass;
- remove admin credential fallbacks only after explicit role secrets are proven;
- remove implicit UUID derivation only after section 11.4 proof;
- remove legacy secret-management surfaces;
- complete Cloudflare least-privilege token handoff and explicitly revoke the old broad token.

### Optional Phase F — canonical host switch

Only after the current optimizer experiment and a separate ingress baseline decision:

- optionally set `CANONICAL_EDGE_HOST` to production `workers.dev`;
- run tunnel/subscription canaries;
- update `PROBE_HOST` to the new canonical hostname;
- treat subsequent ingress measurements as a new baseline;
- retain a Custom Domain as alternate data-plane host where practical.

## 15. Rollback

- Before strict enforcement, rollback keeps the existing primary route while fixing new Access/control-host configuration.
- After strict enforcement, rollback uses a known previous deployment/configuration release; it does not selectively reopen arbitrary control routes on DATA hosts.
- `workers.dev` can be disabled independently if its canary fails; the primary Custom Domain remains available.
- Subscription-token rollback re-enables bounded read-only legacy overlap.
- Ops migration rollback restores NAS control calls to the previously proven endpoint only if that endpoint is still intentionally supported by the current migration phase.
- UUID is never rotated merely for hostname/control-plane rollback; the explicitly materialized effective UUID remains the identity anchor.
- Cloudflare broad-token revocation occurs only after both replacement credentials are proven; after revocation rollback uses the new scoped credentials, not resurrection of the broad token.

## 16. Test and evidence gates

Implementation is not mergeable until all applicable gates pass:

1. host role sets are pairwise disjoint; overlaps fail configuration validation;
2. `CANONICAL_EDGE_HOST` belongs only to DATA;
3. unknown hosts fail before dispatch;
4. complete role-by-sensitive-route negative matrix from section 7 is tested;
5. Custom Domain DATA tunnel/sub/probe path works;
6. production `workers.dev` is not made externally reachable until DATA-only enforcement exists, then tunnel/sub/probe works and all foreign control routes are denied;
7. generated subscriptions use only `CANONICAL_EDGE_HOST`;
8. candidate probing uses candidate IP + `CANONICAL_EDGE_HOST` SNI/Host and the fixed 65,536-byte contract;
9. Access-protected OPS hostname is not used for ingress scoring;
10. NAS ops calls prove Access service credentials + `OPTIMIZER_TOKEN` are both required;
11. NAS probe calls prove Access service credentials are not required/sent on DATA probe;
12. no permanent credential fallback exists between ADMIN/UUID/SUB/OPTIMIZER roles;
13. current effective UUID is materialized explicitly and equality is proven before UUID derivation/fallback removal;
14. existing tunnel client canary succeeds before and after UUID materialization;
15. mandatory legacy subscription overlap is tested through explicit retirement;
16. least-privilege Worker and zone credentials are independently validated;
17. superseded broad Cloudflare token is explicitly revoked after successful handoff;
18. logs/responses expose no credential values;
19. existing tunnel protocol tests remain green;
20. Wrangler dry-run succeeds;
21. rollout does not combine hostname migration with Stage C egress or optimizer-v2 scoring changes;
22. current seven-day fixed-seed optimizer experiment remains unchanged.

## 17. Decisions frozen by this revision

- One Worker remains the default topology.
- Every registered hostname has exactly one role; role sets are pairwise disjoint.
- Unknown hostnames fail closed.
- Production `workers.dev` is a long-lived DR DATA endpoint, but it is never publicly enabled before DATA-only route enforcement exists for it.
- Custom Domain remains the default canonical recommendation; `CANONICAL_EDGE_HOST` may later switch to production `workers.dev` in a separate migration.
- Generated subscriptions use `CANONICAL_EDGE_HOST`, not the incoming request host.
- Stage B ingress probes remain on the DATA Host/SNI path through one exact bounded read-only endpoint.
- NAS control API and ingress probe configuration are separated; Access service credentials apply only to OPS traffic.
- Current effective tunnel UUID is materialized and verified before legacy derivation/fallback removal.
- Subscription-token overlap is mandatory and bounded.
- Cloudflare least-privilege credential migration is incomplete until the superseded broad token is revoked.
- Host separation tests cover the full negative matrix, not only tunnel rejection.
- Current seven-day fixed-seed experiment is not altered by this design.

## 18. References checked 2026-08-24

- Cloudflare Workers routes and domains: https://developers.cloudflare.com/workers/configuration/routing/
- Cloudflare Workers `workers.dev`: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Cloudflare Workers Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Cloudflare Access for Workers/hostnames: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Cloudflare Access service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

These are implementation dependencies and MUST be rechecked immediately before production rollout because Cloudflare product behavior may change.