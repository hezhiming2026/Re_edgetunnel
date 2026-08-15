# B2 Control-Plane Separation and Credential Lifecycle Design

Date: 2026-08-15
Status: design review
Scope: design only; no production routing changes

## 1. Problem statement

The current Worker serves tunnel traffic, subscription delivery, browser administration, and machine optimizer operations on one hostname. Tunnel compatibility benefits from a permissive Cloudflare edge posture, while admin and machine-control endpoints benefit from a strict authentication perimeter. Keeping them on the same hostname forces one edge policy to serve conflicting security requirements.

This design separates those responsibilities into independent planes and removes credential fallback relationships that allow one secret to inherit another secret's authority.

Reusable documentation and tests MUST use placeholders such as `${EDGE_HOSTNAME}`, `${ADMIN_HOSTNAME}`, and `${OPS_HOSTNAME}`. Operator-specific domains, account IDs, tokens, tunnel IDs, and NAS addresses are not part of the reusable contract.

## 2. Goals

1. Keep tunnel traffic on a dedicated data-plane hostname.
2. Move browser administration to a dedicated admin hostname protected by Cloudflare Access and Worker-side admin authentication.
3. Move NAS optimizer and diagnostics to a dedicated ops hostname protected by Cloudflare Access service authentication and the existing machine token.
4. Make ADMIN, UUID, subscription credential, optimizer credential, and Cloudflare API credentials independent and independently rotatable.
5. Remove legacy high-value secret storage and query-string credential handling that no longer serves the B2 architecture.
6. Migrate without breaking existing subscription or tunnel clients.
7. Make host-to-route authorization explicit and testable before DNS/Cloudflare changes are performed.

## 3. Non-goals

- Stage C private NAS egress or selective fallback.
- Changing Stage B ingress scoring.
- Kubernetes or microservice decomposition.
- Replacing Durable Object authority.
- Making the data-plane hostname dependent on Cloudflare Access.

## 4. Terminology

### Data plane

The request path that carries user proxy traffic. It should do as little policy/control work as possible and must remain compatible with tunnel clients.

### Control plane

Endpoints that change or inspect system configuration. In this design it is split into a human admin plane and a machine ops plane.

### Defense in depth

Multiple independent security checks protect the same sensitive action. A failure or leak in one layer is not sufficient to authorize the request.

### Credential blast radius

The set of capabilities exposed if one credential is compromised. The design minimizes blast radius by preventing credential fallback between roles.

## 5. Target architecture

```text
Internet / clients
        |
        +--------------------+--------------------+
        |                    |                    |
 ${EDGE_HOSTNAME}      ${ADMIN_HOSTNAME}     ${OPS_HOSTNAME}
   data plane            admin plane            ops plane
        |                    |                    |
 tunnel protocols       Cloudflare Access    Cloudflare Access
 WS/gRPC/XHTTP          human Allow policy    Service Auth policy
        |                    |                    |
 Worker tunnel auth      Worker ADMIN session   OPTIMIZER_TOKEN
        |                    |                    |
        +--------------------+--------------------+
                             |
                     Durable Object authority
                             |
                         KV mirror only
```

One Worker deployment MAY serve all three custom domains initially. Separation is primarily a hostname + route authorization boundary, not a requirement to create three Worker services. This minimizes migration risk and code duplication.

Cloudflare Workers Custom Domains support attaching multiple custom domains to a Worker. Cloudflare Access supports self-hosted application policies, path/hostname application scopes, and service tokens for automated systems.

## 6. Host-to-route contract

The Worker MUST classify the request hostname before dispatching sensitive routes.

### `${EDGE_HOSTNAME}`

Allowed:

- tunnel WebSocket traffic
- gRPC tunnel traffic
- XHTTP tunnel traffic
- optional subscription endpoint during the compatibility migration window only
- benign masquerade/root response

Denied with fail-closed response:

- `/admin` and `/admin/*`
- `/login`, `/logout`
- `/ops` and `/ops/*`
- any future control-plane mutation route

### `${ADMIN_HOSTNAME}`

Allowed:

- `/login`
- `/logout`
- `/admin` and `/admin/*`
- optional `/sub` management/redirect helper if explicitly required by UI

Denied:

- WebSocket tunnel dispatcher
- gRPC/XHTTP tunnel dispatcher
- `/ops` and `/ops/*`

### `${OPS_HOSTNAME}`

Allowed:

- `/ops/optimizer/v1/*`
- `/ops/egress/v1/*`
- future narrowly scoped machine endpoints

Denied:

- browser admin routes
- subscription routes
- all tunnel dispatchers
- generic masquerade behavior for unknown paths; unknown ops-host paths return 404

The host contract MUST be enforced inside the Worker even if Cloudflare Access is misconfigured or temporarily removed.

## 7. Authentication layers

### 7.1 Data plane

Tunnel authentication remains protocol credential based. `UUID` is a tunnel credential only.

`UUID` MUST NOT be used as:

- admin password fallback
- subscription token seed after migration
- optimizer token fallback

### 7.2 Admin plane

Layer 1: Cloudflare Access human policy.

Layer 2: Worker-side `ADMIN` login/session.

`ADMIN` is required for admin functionality and has no fallback to `PASSWORD`, `TOKEN`, `KEY`, `UUID`, or any other credential.

The existing secure cookie requirements remain minimum requirements:

- Secure
- HttpOnly
- SameSite=Strict
- bounded TTL

State-changing admin requests retain same-origin/CSRF checks.

### 7.3 Ops plane

Layer 1: Cloudflare Access Service Auth using a dedicated NAS service token.

Layer 2: Worker `Authorization: Bearer <OPTIMIZER_TOKEN>` machine authentication.

The service-token credential and `OPTIMIZER_TOKEN` MUST be different secrets and independently revocable.

The NAS must not receive a Cloudflare account API token merely to call ops APIs.

## 8. Subscription credential redesign

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

## 9. Legacy secret surface removal

The following legacy features should be removed rather than hardened unless a concrete current use case is identified during implementation review:

1. Admin endpoint that accepts Cloudflare Global API Key / API Token through URL query parameters.
2. Persistence of Cloudflare high-value credentials in KV (`cf.json`).
3. Persistence of Telegram bot credentials in general configuration KV if Telegram integration is retained without a dedicated secret binding.
4. Generic admin password fallback through `PASSWORD`, `TOKEN`, `KEY`, or `UUID` aliases.

If Telegram notification remains desired, its bot token becomes a Worker secret and only non-sensitive notification configuration may remain in KV.

## 10. Cloudflare deployment credential separation

The current production workflow uses one Cloudflare API token across Worker/KV deployment and Zone/WAF configuration. Split capabilities:

### Worker deploy token

Only permissions required to deploy the Worker, manage required Worker resources, and bind the production KV/DO configuration.

### Zone security token

Only permissions required to manage the intended hostname-scoped Zone/WAF rules.

Security policy configuration should become an explicit, separately triggered infrastructure action rather than an implicit mutation on every Worker deploy.

This reduces credential blast radius and makes Worker deployment deterministic even if Zone security configuration is unchanged.

## 11. Cloudflare edge-policy strategy

### Data hostname

May retain tunnel-compatible edge settings required for non-browser clients. These relaxed settings apply only to `${EDGE_HOSTNAME}`.

### Admin hostname

Protected by an Access self-hosted application with deny-by-default semantics and a human Allow policy. Worker admin auth remains mandatory behind Access.

### Ops hostname

Protected by an Access self-hosted application with Service Auth policy tied to the NAS service token. Worker `OPTIMIZER_TOKEN` remains mandatory behind Access.

No global zone weakening is introduced.

## 12. Migration phases

### Phase A — contracts only

- Add host classification module.
- Add host/route matrix tests.
- Add strict credential-loading tests.
- Add independent subscription-token tests.
- No routing or credential behavior changes in production.

### Phase B — additive hostnames

- Add `${ADMIN_HOSTNAME}` and `${OPS_HOSTNAME}` as additional Custom Domains.
- Configure Cloudflare Access policies.
- Keep old control routes temporarily available on `${EDGE_HOSTNAME}` behind a migration flag.
- Validate admin, ops, subscription, and tunnel behavior from real networks.

### Phase C — client migration

- Point NAS optimizer to `${OPS_HOSTNAME}` with Access service credentials + optimizer token.
- Move browser admin bookmarks/usage to `${ADMIN_HOSTNAME}`.
- Rotate to independent `SUB_TOKEN` and update subscription clients.

### Phase D — retire legacy control routes

- Disable admin and ops routes on `${EDGE_HOSTNAME}`.
- Remove legacy credential fallback.
- Remove legacy CF/TG secret-management endpoints and stored secret material after backup/rotation decisions.

### Phase E — security policy cleanup

- Scope data-plane compatibility rules to `${EDGE_HOSTNAME}` only.
- Verify admin/ops Access enforcement.
- Split deploy and Zone-security GitHub secrets/tokens.

## 13. Rollback strategy

Migration MUST be reversible without changing tunnel credentials.

- Additional hostnames are introduced before old routes are removed.
- Old control routes remain available only during a bounded compatibility period.
- If Access or hostname migration fails, revert clients/NAS to the previous hostname before disabling new routes.
- Do not rotate `UUID` as part of control-plane rollback.
- Credential rotation is a separate explicit step with documented previous/new overlap where needed.

## 14. Test and evidence gates

Before implementation is mergeable:

1. Host matrix unit tests prove each sensitive route is accepted only on its plane.
2. Tunnel tests prove admin/ops hostnames cannot start tunnel sessions.
3. Credential tests prove no fallback between ADMIN/UUID/SUB/OPTIMIZER roles.
4. Ops tests prove both Access-layer expectations (deployment configuration evidence) and Worker machine auth remain required.
5. Admin mutation tests retain same-origin protections.
6. Logs and responses do not expose credential values.
7. Existing tunnel protocol test suite remains green.
8. Wrangler dry-run succeeds for all configured Custom Domains.
9. Production rollout uses an explicit canary/checklist and does not combine hostname migration with Stage C egress work.

## 15. Operational decisions to freeze before implementation

- Exact operator-selected `${ADMIN_HOSTNAME}` and `${OPS_HOSTNAME}` values stay outside reusable committed examples until deployment configuration is intentionally applied.
- Decide whether one Worker with three Custom Domains remains the long-term topology; default recommendation is yes unless isolation requirements later justify separate Workers.
- Decide whether Telegram integration is retained. If retained, move token material to Worker secrets.
- Decide the duration of legacy subscription-token overlap before implementation rollout.

## 16. References checked 2026-08-15

- Cloudflare Workers Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Cloudflare Access policies: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- Cloudflare Access application paths: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- Cloudflare Access service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

These are implementation dependencies and must be rechecked before production rollout because Cloudflare product behavior can change.
