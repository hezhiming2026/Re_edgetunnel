# B2 Control-Plane Separation and Credential Lifecycle Design

Date: 2026-08-15
Updated: 2026-08-24
Status: design review
Scope: design only; no production routing changes

## 1. Problem statement

The current Worker serves tunnel traffic, subscription delivery, browser administration, and machine optimizer operations on one hostname. Tunnel compatibility benefits from a permissive Cloudflare edge posture, while admin and machine-control endpoints benefit from a strict authentication perimeter. Keeping them on the same hostname forces one edge policy to serve conflicting security requirements.

This design separates those responsibilities into independent planes and removes credential fallback relationships that allow one secret to inherit another secret's authority.

Reusable documentation and tests MUST use placeholders. Operator-specific domains, account IDs, tokens, tunnel IDs, and NAS addresses are not part of the reusable contract.

## 2. Goals

1. Keep tunnel traffic on explicitly registered data-plane hostnames.
2. Keep one canonical data-plane hostname for subscription generation while allowing additional disaster-recovery data-plane hostnames.
3. Move browser administration to a dedicated admin hostname protected by Cloudflare Access and Worker-side admin authentication.
4. Move NAS optimizer and diagnostics to a dedicated ops hostname protected by Cloudflare Access service authentication and the existing machine token.
5. Make ADMIN, UUID, subscription credential, optimizer credential, and Cloudflare API credentials independent and independently rotatable.
6. Remove legacy high-value secret storage and query-string credential handling that no longer serves the B2 architecture.
7. Migrate without breaking existing subscription or tunnel clients.
8. Make host-to-route authorization explicit, default-deny, and testable before DNS/Cloudflare changes are performed.
9. Support a long-lived `workers.dev` disaster-recovery data-plane endpoint without making unrecognized Worker hostnames implicitly trusted.

## 3. Non-goals

- Stage C private NAS egress or selective fallback.
- Changing Stage B ingress scoring.
- Kubernetes or microservice decomposition.
- Replacing Durable Object authority.
- Making the data plane dependent on interactive Cloudflare Access.
- Switching production traffic to `workers.dev` during the current NAS measurement window.

## 4. Terminology

### Data plane

The request path that carries user proxy traffic. It should do as little policy/control work as possible and must remain compatible with tunnel clients.

### Control plane

Endpoints that change or inspect system configuration. In this design it is split into a human admin plane and a machine ops plane.

### Host role allowlist

A configuration mapping from explicitly trusted hostnames to roles. A hostname that is not explicitly registered has no role and MUST fail closed before route dispatch.

### Canonical edge host

The single hostname emitted into subscription-generated tunnel nodes. It is independent from the set of all hostnames that are allowed to carry data-plane traffic.

### Defense in depth

Multiple independent security checks protect the same sensitive action. A failure or leak in one layer is not sufficient to authorize the request.

### Credential blast radius

The set of capabilities exposed if one credential is compromised. The design minimizes blast radius by preventing credential fallback between roles.

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
 WS/gRPC/XHTTP           WS/gRPC/XHTTP         human Allow policy     Service Auth policy
        |                       |                    |                    |
 Worker tunnel auth      Worker tunnel auth     Worker ADMIN session   OPTIMIZER_TOKEN
        |                       |                    |                    |
        +-----------------------+--------------------+--------------------+
                                    |
                            Durable Object authority
                                    |
                                KV mirror only
```

One Worker deployment MAY serve all roles initially. Separation is primarily a hostname + route authorization boundary, not a requirement to create separate Worker services.

Cloudflare currently supports multiple Custom Domains per Worker and a `workers.dev` route for the same Worker. `workers.dev` is an official long-lived routing option but Cloudflare recommends Custom Domains or Routes for production. This project therefore treats `workers.dev` as an always-supported disaster-recovery data-plane endpoint, while retaining a Custom Domain as the default primary/canonical endpoint unless the operator explicitly changes it.

## 6. Host configuration contract

The implementation MUST separate two concepts:

```text
DATA_PLANE_HOSTS     = all explicitly trusted hostnames allowed to carry tunnel traffic
CANONICAL_EDGE_HOST  = the one hostname emitted into generated subscriptions
```

Example reusable configuration shape:

```text
DATA_PLANE_HOSTS=${EDGE_HOSTNAME},${WORKERS_DEV_HOSTNAME}
CANONICAL_EDGE_HOST=${EDGE_HOSTNAME}
ADMIN_HOSTS=${ADMIN_HOSTNAME}
OPS_HOSTS=${OPS_HOSTNAME}
```

`CANONICAL_EDGE_HOST` MUST be a member of `DATA_PLANE_HOSTS`.

The operator may later switch:

```text
CANONICAL_EDGE_HOST=${WORKERS_DEV_HOSTNAME}
```

without changing UUID/tunnel credentials, provided that the `workers.dev` route is enabled and included in `DATA_PLANE_HOSTS`.

Changing the canonical host is a client-routing migration, not an authentication migration.

## 7. Host-to-route contract

The Worker MUST classify the request hostname before dispatching any sensitive or tunnel route.

### Any hostname in `DATA_PLANE_HOSTS`

Allowed:

- tunnel WebSocket traffic
- gRPC tunnel traffic
- XHTTP tunnel traffic
- canonical subscription endpoint during and after migration
- benign masquerade/root response

Denied with fail-closed response:

- `/admin` and `/admin/*`
- `/login`, `/logout`
- `/ops` and `/ops/*`
- any future control-plane mutation route

### Any hostname in `ADMIN_HOSTS`

Allowed:

- `/login`
- `/logout`
- `/admin` and `/admin/*`
- optional `/sub` helper only if it redirects to the canonical subscription URL; it MUST NOT render tunnel nodes using the admin request Host

Denied:

- WebSocket tunnel dispatcher
- gRPC/XHTTP tunnel dispatcher
- `/ops` and `/ops/*`

### Any hostname in `OPS_HOSTS`

Allowed:

- `/ops/optimizer/v1/*`
- `/ops/egress/v1/*`
- future narrowly scoped machine endpoints

Denied:

- browser admin routes
- subscription routes
- all tunnel dispatchers
- generic masquerade behavior for unknown paths; unknown ops-host paths return 404

### Unknown / unregistered hostname

Any hostname that does not belong to `DATA_PLANE_HOSTS`, `ADMIN_HOSTS`, or `OPS_HOSTS` MUST be rejected before route dispatch with a non-sensitive 404 or 403 response.

This applies even when the request reaches the same Worker through:

- an accidentally added Custom Domain;
- a stale route;
- an unexpected preview hostname;
- a renamed or extra `workers.dev` hostname;
- any future routing surface not explicitly registered in the role allowlist.

This is intentionally default-deny. Supporting a new hostname requires adding it to an explicit role allowlist; it does not require changing the route implementation.

The host contract MUST be enforced inside the Worker even if Cloudflare Access is misconfigured or temporarily removed.

## 8. `workers.dev` disaster-recovery policy

The `workers.dev` hostname is a first-class supported disaster-recovery data-plane route.

Policy:

1. The implementation MUST support enabling `workers.dev` and adding its exact production hostname to `DATA_PLANE_HOSTS`.
2. The production `workers.dev` hostname MAY remain enabled continuously as a disaster-recovery endpoint.
3. It MUST NOT implicitly gain admin or ops privileges merely because it belongs to the Worker deployment.
4. Preview URLs remain untrusted unless separately and explicitly added to a role; default is deny.
5. The current default recommendation is:

```text
primary/canonical = operator Custom Domain
disaster recovery = production workers.dev hostname
```

6. The operator MAY later choose `workers.dev` as `CANONICAL_EDGE_HOST` if operational convenience outweighs the benefit of a portable custom domain.
7. Such a switch requires an explicit migration check because the Worker name/account subdomain becomes part of the client endpoint.
8. Production switching between Custom Domain and `workers.dev` MUST NOT occur during a controlled optimizer measurement/calibration window unless intentionally starting a new experiment baseline.

Rationale: keeping `workers.dev` available removes registrar-expiry dependency, while retaining a Custom Domain preserves portability, a stable operator-controlled name, and Cloudflare's currently recommended production routing model.

## 9. Subscription hostname contract

Subscription authorization and subscription endpoint hosting are separate from the hostname written into generated nodes.

All generated VLESS/Trojan/SS or other tunnel node addresses MUST use `CANONICAL_EDGE_HOST` for the endpoint Host/SNI unless an individual protocol contract explicitly requires otherwise.

The generator MUST NOT derive the tunnel hostname from `request.url.hostname`.

Therefore:

```text
GET https://${ADMIN_HOSTNAME}/sub
```

if retained as a compatibility helper, MUST either:

1. redirect to the canonical subscription URL on `CANONICAL_EDGE_HOST`; or
2. render a response whose tunnel nodes still use `CANONICAL_EDGE_HOST`.

Preferred implementation is redirect-only on the admin plane so there is a single canonical subscription rendering path.

When the operator changes `CANONICAL_EDGE_HOST`, refreshing the subscription is sufficient to move clients to the new endpoint without rotating UUID or other tunnel credentials.

## 10. Authentication layers

### 10.1 Data plane

Tunnel authentication remains protocol credential based. `UUID` is a tunnel credential only.

`UUID` MUST NOT be used as:

- admin password fallback
- subscription token seed after migration
- optimizer token fallback

### 10.2 Admin plane

Layer 1: Cloudflare Access human policy.

Layer 2: Worker-side `ADMIN` login/session.

`ADMIN` is required for admin functionality and has no fallback to `PASSWORD`, `TOKEN`, `KEY`, `UUID`, or any other credential.

The existing secure cookie requirements remain minimum requirements:

- Secure
- HttpOnly
- SameSite=Strict
- bounded TTL

State-changing admin requests retain same-origin/CSRF checks.

### 10.3 Ops plane

Layer 1: Cloudflare Access Service Auth using a dedicated NAS service token.

Layer 2: Worker `Authorization: Bearer <OPTIMIZER_TOKEN>` machine authentication.

The service-token credential and `OPTIMIZER_TOKEN` MUST be different secrets and independently revocable.

The NAS must not receive a Cloudflare account API token merely to call ops APIs.

## 11. Subscription credential redesign

Current subscription authorization is derived from tunnel identity. This couples two roles and makes independent revocation difficult.

Introduce an independent `SUB_TOKEN` secret or a keyed HMAC scheme rooted in a dedicated `SUB_SECRET`.

Preferred initial implementation: random `SUB_TOKEN` secret because the deployment is single-operator and does not need per-user token derivation complexity.

Requirements:

- minimum 32 random bytes before encoding
- constant-time comparison after hashing or equivalent bounded comparison
- no query token in logs
- independently rotatable without changing `UUID`
- migration window where legacy subscription token can be accepted read-only if explicitly enabled
- legacy acceptance disabled after clients migrate

## 12. Legacy secret surface removal

The following legacy features should be removed rather than hardened unless a concrete current use case is identified during implementation review:

1. Admin endpoint that accepts Cloudflare Global API Key / API Token through URL query parameters.
2. Persistence of Cloudflare high-value credentials in KV (`cf.json`).
3. Persistence of Telegram bot credentials in general configuration KV if Telegram integration is retained without a dedicated secret binding.
4. Generic admin password fallback through `PASSWORD`, `TOKEN`, `KEY`, or `UUID` aliases.

If Telegram notification remains desired, its bot token becomes a Worker secret and only non-sensitive notification configuration may remain in KV.

## 13. Cloudflare deployment credential separation

The current production workflow uses one Cloudflare API token across Worker/KV deployment and Zone/WAF configuration. Split capabilities:

### Worker deploy token

Only permissions required to deploy the Worker, manage required Worker resources, and bind the production KV/DO configuration.

### Zone security token

Only permissions required to manage the intended hostname-scoped Zone/WAF rules.

Security policy configuration should become an explicit, separately triggered infrastructure action rather than an implicit mutation on every Worker deploy.

This reduces credential blast radius and makes Worker deployment deterministic even if Zone security configuration is unchanged.

## 14. Cloudflare edge-policy strategy

### Data-plane hostnames

Custom Domain and production `workers.dev` data-plane hostnames may use tunnel-compatible edge settings required for non-browser clients. Relaxations MUST be scoped to the specific data hostname whenever the Cloudflare product supports such scoping.

### Admin hostname

Protected by an Access self-hosted application with deny-by-default semantics and a human Allow policy. Worker admin auth remains mandatory behind Access.

### Ops hostname

Protected by an Access self-hosted application with Service Auth policy tied to the NAS service token. Worker `OPTIMIZER_TOKEN` remains mandatory behind Access.

No global zone weakening is introduced.

## 15. Migration phases

### Phase A — contracts only

- Add host role classification module.
- Add unknown-host default-deny tests.
- Add host/route matrix tests.
- Add canonical subscription-host tests.
- Add strict credential-loading tests.
- Add independent subscription-token tests.
- No routing or credential behavior changes in production.

### Phase B — additive hostnames

- Enable the production `workers.dev` route as a registered data-plane DR hostname.
- Add `${ADMIN_HOSTNAME}` and `${OPS_HOSTNAME}` as additional Custom Domains.
- Configure Cloudflare Access policies.
- Keep old control routes temporarily available on the existing data-plane host behind a migration flag.
- Validate admin, ops, subscription, tunnel, Custom Domain, and `workers.dev` behavior from real networks.

### Phase C — client migration

- Point NAS optimizer to `${OPS_HOSTNAME}` with Access service credentials + optimizer token.
- Move browser admin bookmarks/usage to `${ADMIN_HOSTNAME}`.
- Rotate to independent `SUB_TOKEN` and update subscription clients.
- Keep `CANONICAL_EDGE_HOST` on the existing Custom Domain initially unless performing a separate intentional data-plane hostname migration.

### Phase D — retire legacy control routes

- Disable admin and ops routes on every data-plane hostname.
- Remove legacy credential fallback.
- Remove legacy CF/TG secret-management endpoints and stored secret material after backup/rotation decisions.

### Phase E — security policy cleanup

- Scope data-plane compatibility rules to explicit data-plane hostnames only.
- Verify admin/ops Access enforcement.
- Split deploy and Zone-security GitHub secrets/tokens.

### Optional Phase F — canonical host switch

If the operator later chooses `workers.dev` as the primary/canonical endpoint:

- confirm the production `workers.dev` route is enabled and in `DATA_PLANE_HOSTS`;
- set `CANONICAL_EDGE_HOST` to that exact production `workers.dev` hostname;
- run subscription and tunnel canaries;
- refresh clients;
- retain at least one Custom Domain as an alternate data-plane hostname where practical;
- do not rotate UUID merely for the hostname switch.

## 16. Rollback strategy

Migration MUST be reversible without changing tunnel credentials.

- Additional hostnames are introduced before old routes are removed.
- Old control routes remain available only during a bounded compatibility period.
- Both Custom Domain and production `workers.dev` data-plane endpoints may coexist.
- If Access or hostname migration fails, revert clients/NAS to the previous registered hostname before disabling the new one.
- A canonical-host switch is rolled back by restoring the previous `CANONICAL_EDGE_HOST` and refreshing subscription clients.
- Do not rotate `UUID` as part of control-plane or hostname rollback.
- Credential rotation is a separate explicit step with documented previous/new overlap where needed.

## 17. Test and evidence gates

Before implementation is mergeable:

1. Host matrix unit tests prove each sensitive route is accepted only on its plane.
2. Unknown/unregistered host tests prove route dispatch is not reached.
3. Tunnel tests prove admin/ops hostnames cannot start tunnel sessions.
4. Data-plane tests prove both the primary Custom Domain and explicitly registered production `workers.dev` hostname can start tunnel sessions.
5. Subscription tests prove output always uses `CANONICAL_EDGE_HOST`, never the incoming admin/ops Host.
6. Tests prove `CANONICAL_EDGE_HOST` must belong to `DATA_PLANE_HOSTS`.
7. Credential tests prove no fallback between ADMIN/UUID/SUB/OPTIMIZER roles.
8. Ops tests prove both Access-layer expectations (deployment configuration evidence) and Worker machine auth remain required.
9. Admin mutation tests retain same-origin protections.
10. Logs and responses do not expose credential values.
11. Existing tunnel protocol test suite remains green.
12. Wrangler dry-run succeeds for configured Custom Domains and the intended `workers.dev` setting.
13. Production rollout uses an explicit canary/checklist and does not combine hostname migration with Stage C egress work or optimizer calibration changes.

## 18. Operational decisions frozen by this revision

- One Worker remains the default long-term topology unless later isolation requirements justify separate Workers.
- A production `workers.dev` hostname is supported as a continuously available disaster-recovery data-plane endpoint.
- Default primary/canonical recommendation remains an operator Custom Domain because Cloudflare currently recommends Custom Domains/Routes for production and a custom domain preserves portability.
- `CANONICAL_EDGE_HOST` is independently switchable to the production `workers.dev` hostname without changing tunnel credentials.
- Unknown/unregistered hostnames always fail closed.
- Admin `/sub` compatibility behavior is redirect-only or canonical-host rendering; it never emits the admin hostname into tunnel nodes.
- Exact operator-selected hostnames stay outside reusable committed examples until deployment configuration is intentionally applied.
- Telegram retention and legacy subscription-token overlap duration remain separate implementation decisions.

## 19. References checked 2026-08-24

- Cloudflare Workers routes and domains: https://developers.cloudflare.com/workers/configuration/routing/
- Cloudflare Workers `workers.dev`: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Cloudflare Workers Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Cloudflare Access for Workers/hostnames: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Cloudflare Access service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

These are implementation dependencies and must be rechecked before production rollout because Cloudflare product behavior can change.
