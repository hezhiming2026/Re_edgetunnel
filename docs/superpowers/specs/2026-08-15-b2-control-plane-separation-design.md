# B2 Control-Plane Separation and Credential Lifecycle Design

Date: 2026-08-15
Updated: 2026-08-25
Status: design review
Scope: design only; no production routing changes

## 1. Problem statement

The current Worker serves tunnel traffic, subscription delivery, browser administration, and machine optimizer operations on one hostname. Tunnel compatibility benefits from a permissive Cloudflare edge posture, while admin and machine-control endpoints benefit from a strict authentication perimeter. Keeping them on the same hostname forces one edge policy to serve conflicting security requirements.

This design separates those responsibilities into independent host roles, preserves Stage B ingress measurement semantics, and removes credential fallback relationships without rotating the currently effective tunnel identity or breaking documented legacy subscription paths.

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
10. Migrate in bounded stages with explicit rollback gates, including safe rollback from any enforcement-capable release.

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

### Legacy KEY shortcut

The documented exact `/<KEY>` subscription shortcut. It is a read-only compatibility route, not a general authorization mechanism and not admin authority.

### Admin session epoch

A version/namespace included in Worker-side admin-session validation. Rotating it invalidates every session minted under the previous credential boundary without requiring knowledge of individual cookies.

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

Normalization MUST occur before membership/overlap checks and at minimum handles lowercase hostname, no port, and one canonical trailing-dot form.

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
| bounded legacy `/<KEY>` shortcut during migration overlap | read-only redirect/render compatibility only | deny | deny | deny |
| `/login`, `/logout`, `/admin/*` | deny | allow | deny | deny |
| general `/ops/*` mutation/status/diagnostics | deny | deny | allow | deny |
| exact bounded ingress probe | allow | deny | deny for scoring | deny |
| benign data masquerade/root | allow | deny unless explicitly required | deny | deny |

The only control-looking exception on a DATA hostname is the exact bounded read-only ingress probe defined in section 8. The legacy `/<KEY>` route, while its migration overlap is active, is also exact-match and read-only; it confers no admin/ops authority and MUST NOT be implemented as a prefix/wildcard route.

Tests MUST cover every negative cell above, including DATA rejecting login/admin/general ops, ADMIN rejecting tunnels/general ops/probe, OPS rejecting tunnels/subscription/admin/probe-for-scoring, and unknown host rejecting everything before dispatch.

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

The handler MUST accept GET only, require `OPTIMIZER_TOKEN` or an equivalent dedicated probe credential, perform no KV/DO mutation or outbound fetch/dial, return exactly 65,536 deterministic bytes, send `Cache-Control: no-store`, expose no control-plane state/secrets, work through each registered DATA hostname, and be tested by dialing candidate IP + `CANONICAL_EDGE_HOST` SNI/Host.

### 8.2 Separate NAS endpoints and credentials

Control traffic and measurement traffic MUST be configured separately with equivalent settings to:

```text
OPS_BASE_URL=https://${OPS_HOSTNAME}
PROBE_HOST=${CANONICAL_EDGE_HOST}
CF_ACCESS_CLIENT_ID=<secret>
CF_ACCESS_CLIENT_SECRET=<secret>
OPTIMIZER_TOKEN=<secret>
```

Rules:

- status/publish/rollback/egress-diagnostic calls use `OPS_BASE_URL`;
- ops calls send Cloudflare Access service-token headers and Worker `Authorization: Bearer <OPTIMIZER_TOKEN>`;
- candidate probes dial candidate IP while keeping `PROBE_HOST` as TLS SNI/HTTP Host;
- Access service credentials are never sent to the DATA probe;
- `WORKER_BASE_URL` MUST NOT remain an ambiguous single setting once the split is activated;
- NAS canaries test ops and probe paths independently.

Before moving any NAS ops consumer to the Access-protected host, the Access service token MUST already be provisioned, installed on NAS, and verified end-to-end.

## 9. `workers.dev` disaster-recovery policy

The production `workers.dev` hostname is a first-class long-lived DR DATA endpoint.

1. Its exact production hostname must be explicitly present in `DATA_PLANE_HOSTS` before use.
2. It never implicitly gains admin or ops authority.
3. Preview URLs remain untrusted by default.
4. Default recommendation remains Custom Domain primary/canonical with production `workers.dev` as disaster recovery.
5. The operator MAY later choose `workers.dev` as `CANONICAL_EDGE_HOST` in a separate migration without UUID rotation.
6. It MUST NOT be enabled publicly while host-agnostic control routing could expose `/login`, `/admin/*`, or general `/ops/*` on that hostname.
7. Therefore `workers.dev` is enabled only atomically with DATA-only role enforcement already active for it.
8. Do not switch the canonical host during the current fixed-seed experiment.

### 9.1 Rollback invariant for `workers.dev`

Once `workers.dev` has become publicly reachable, any rollback to a Worker release/configuration that does not enforce the DATA-only host matrix MUST first disable the public `workers.dev` route, or disable it atomically with that rollback.

Required order:

```text
disable workers.dev route (or prepare atomic disable)
-> verify it is no longer externally reachable as a Worker route
-> roll back to pre-enforcement Worker release
```

A rollback that restores host-agnostic dispatch while leaving `workers.dev` public is forbidden because it would re-expose login/admin/general-ops routes on the DR hostname.

If the route cannot be disabled safely, rollback to a pre-enforcement release is blocked; use an enforcement-capable known-good release or a forward fix instead.

## 10. Subscription hostname and token contract

### 10.1 Canonical subscription output

All generated tunnel nodes MUST use `CANONICAL_EDGE_HOST` for endpoint Host/SNI. The generator MUST NOT derive the tunnel hostname from `request.url.hostname`.

An admin-plane `/sub` helper, if retained, is redirect-only to the canonical DATA subscription URL.

### 10.2 Independent `SUB_TOKEN`

Introduce an independent random `SUB_TOKEN` (preferred for this single-operator deployment) or dedicated HMAC secret. It is independently rotatable without changing UUID and MUST NOT be logged.

### 10.3 Mandatory bounded legacy overlap

Migration from hostname/UUID-derived subscription authorization MUST have a read-only overlap. Immediate cutover is forbidden.

```text
new SUB_TOKEN accepted = yes
legacy subscription token accepted read-only = yes
legacy exact /<KEY> shortcut accepted read-only = yes, only while required by overlap
legacy credential mutation authority = none
```

The exact `/<KEY>` shortcut is part of the compatibility surface because existing documented clients may refresh through it without directly presenting the derived legacy subscription token. Strict host enforcement MUST NOT silently remove it before its users are migrated.

The shortcut MAY be retired before Phase D only if the operator can prove every known client that used it has been migrated and successfully refreshed through the new canonical `SUB_TOKEN` URL. Otherwise it remains enabled on DATA hosts through the bounded overlap and is removed together with the legacy subscription authorization at the explicit retirement gate.

Legacy acceptance may be disabled only after:

1. the new canonical subscription URL using `SUB_TOKEN` refreshes successfully;
2. every known client refreshes successfully at least once with the new token;
3. every known `/<KEY>` shortcut user has migrated, or no such user exists with evidence;
4. at least 24 hours of grace passes after the last known client migration with no required legacy use;
5. the operator explicitly completes the retirement gate.

Rollback may re-enable the bounded read-only legacy token and exact `/<KEY>` shortcut without changing UUID.

## 11. Credential-role contract

### 11.1 Tunnel UUID

`UUID` authorizes tunnel protocol identity only. It is not an admin password, subscription token, or optimizer token.

### 11.2 Admin credential

Cloudflare Access human policy is layer 1. Worker `ADMIN` session/auth is layer 2.

`ADMIN` has no permanent fallback to `PASSWORD`, `TOKEN`, `KEY`, `UUID`, or other aliases after migration.

Admin sessions MUST also be bound to the current admin credential boundary through an explicit `ADMIN_SESSION_EPOCH` (or equivalent namespace/version). A session minted under an older epoch is invalid even if its KV record has not yet expired.

### 11.3 Ops credentials

Cloudflare Access Service Auth is layer 1. `OPTIMIZER_TOKEN` is layer 2. Access service credentials and `OPTIMIZER_TOKEN` are independent and separately revocable.

### 11.4 Atomic ADMIN + effective-UUID identity cutover

Legacy code can couple admin resolution and tunnel identity derivation. In particular, when explicit `UUID` is omitted or invalid, changing `ADMIN` first may change the input used to derive the effective tunnel UUID. Therefore an ADMIN-only intermediate deployment is forbidden whenever admin/UUID derivation are coupled.

Before changing `ADMIN`, `UUID`, or any legacy alias involved in either calculation, the migration MUST, using the still-running pre-cutover configuration:

1. compute and record as non-secret evidence the exact **pre-change effective tunnel UUID** value/fingerprint produced by the current production algorithm;
2. determine the currently effective admin-credential source and whether any `UUID`/`KEY`/legacy alias participates in admin resolution or tunnel UUID derivation;
3. prepare a new independent high-entropy `ADMIN` secret;
4. prepare explicit `UUID = <pre-change effective tunnel UUID>` exactly, byte-for-byte;
5. prepare a new `ADMIN_SESSION_EPOCH` value and the code/configuration that rejects all prior-epoch sessions;
6. prepare removal/disablement of every affected `UUID`/`KEY`/legacy alias as an admin-password fallback.

For a coupled legacy deployment, steps 3–6 MUST become effective in **one atomic identity-boundary cutover** (one release/configuration transaction from the application's perspective). There MUST NOT be a reachable state in which:

- the new `ADMIN` is active while tunnel identity is still being re-derived from the changed admin input;
- the pre-change effective tunnel UUID becomes an accepted admin password;
- a legacy admin alias remains accepted after the new independent ADMIN boundary is declared established.

If the platform cannot make the secret/config/code changes atomic, use a compatibility release that first makes tunnel UUID resolution depend only on an explicit pre-change UUID and makes admin session validation epoch-aware **without changing the effective admin input**, then perform the final ADMIN/fallback/session-epoch switch. Every intermediate state must prove the tunnel UUID remains the pre-change value and that no tunnel-visible credential gains admin authority.

### 11.5 Post-cutover identity and session proof

Immediately after the atomic identity-boundary cutover, all of the following are mandatory before proceeding:

1. effective tunnel UUID after cutover equals the recorded pre-change effective UUID exactly;
2. existing subscription output and at least one real tunnel client authenticate with that unchanged UUID;
3. the dedicated ADMIN hostname authenticates through Cloudflare Access plus the new explicit `ADMIN`;
4. `UUID`, `KEY`, and every retired legacy alias fail Worker admin authentication;
5. an admin session cookie minted before the epoch rotation is rejected even when its old KV record still exists;
6. a newly minted session under the new ADMIN epoch succeeds only on the ADMIN role;
7. session epoch/namespace rotation or purge evidence is recorded without logging credentials/cookies.

If any equality/authentication/session-invalidation proof fails, the credential-boundary migration is blocked and must roll forward/back only through a state that preserves the pre-change tunnel UUID and does not resurrect legacy admin authority.

This operation is identity materialization and privilege separation, not UUID rotation.

## 12. Legacy secret surface removal

Unless a concrete use case is proven, remove after migration gates pass:

1. admin query-string Cloudflare Global API Key/API Token handling;
2. Cloudflare high-value credential persistence in KV (`cf.json`);
3. Telegram bot-token persistence in general KV; retained Telegram token becomes a Worker secret;
4. generic admin-password fallback through `PASSWORD`, `TOKEN`, `KEY`, or `UUID` after section 11 atomic cutover;
5. implicit UUID derivation only after section 11 proves explicit UUID equality;
6. legacy `/<KEY>` subscription shortcut only after section 10.3 retirement gates are satisfied.

Old admin-session namespaces/epochs MUST never be re-enabled during rollback merely to recover access. Rollback uses the explicit ADMIN boundary or a known-good enforcement-capable release.

## 13. Cloudflare deployment credential separation and revocation

Replace the current broad Cloudflare credential with least-privilege Worker deploy and zone-security credentials.

Required handoff:

1. create least-privilege Worker deploy token;
2. create least-privilege zone-security token if needed;
3. update CI/secrets to use each token only for its role;
4. successfully validate Worker deployment with the new deploy token;
5. validate the intended zone/security operation with the new zone token;
6. confirm no workflow/runtime path still depends on the old broad token;
7. explicitly revoke/delete the superseded broad token at Cloudflare;
8. record non-secret revocation evidence/time.

Failure to revoke the old broad credential means least-privilege migration is incomplete.

## 14. Migration sequencing

### Phase A — code/contracts only

- implement host-role classifier and pairwise-disjoint validation;
- implement complete host-role negative matrix tests;
- implement canonical subscription host logic;
- implement bounded DATA probe;
- add strict credential-role tests;
- add pre-change effective-UUID calculation and atomic ADMIN/UUID cutover support/tests;
- add admin-session epoch/namespace invalidation support/tests;
- add split NAS ops/probe configuration support;
- add exact read-only legacy `/<KEY>` compatibility handling;
- production behavior remains unchanged.

### Phase B — provision control hosts; DR DATA route disabled

- add/provision `ADMIN_HOSTNAME` and `OPS_HOSTNAME`;
- configure Access human and Service Auth policies;
- provision NAS Access service credentials;
- verify Access reaches the ADMIN host boundary without changing the legacy Worker admin/tunnel credential inputs yet;
- verify ops host with Access service token + `OPTIMIZER_TOKEN`;
- verify separate NAS ops/probe configuration;
- do not enable production `workers.dev` while host-agnostic routing remains active.

### Phase C — migrate consumers and perform atomic identity-boundary cutover

Order is normative:

1. compute the pre-change effective tunnel UUID and audit all legacy admin/tunnel credential inputs while the old production configuration is still intact;
2. move machine mutation/status calls to `OPS_BASE_URL` with Access service credentials + `OPTIMIZER_TOKEN`;
3. keep candidate probing on candidate IP + `CANONICAL_EDGE_HOST` via bounded DATA probe;
4. enable `SUB_TOKEN` with mandatory read-only legacy token and `/<KEY>` overlap;
5. migrate/verify known subscription clients and legacy shortcut users;
6. prepare explicit `UUID=<pre-change effective UUID>`, independent `ADMIN`, new admin session epoch, and legacy-admin-fallback removal;
7. perform the section 11.4 atomic identity-boundary cutover; no ADMIN-only intermediate state is allowed for coupled deployments;
8. perform every post-cutover tunnel/admin/legacy-cookie proof in section 11.5;
9. move normal browser admin use to `ADMIN_HOSTNAME` under the new explicit ADMIN/session epoch.

### Phase D — atomic host-role enforcement and `workers.dev` enablement

After Phase C evidence is complete:

1. deploy strict host-role enforcement for existing registered roles;
2. verify all negative matrix cells;
3. confirm any still-required `/<KEY>` route is exact-match/read-only only;
4. only then enable exact production `workers.dev` with DATA-only enforcement already active;
5. canary `workers.dev` tunnel/sub/probe behavior and confirm login/admin/general ops are rejected from first public availability.

No compatibility flag may reopen admin/general-ops authority on a DATA hostname.

### Phase E — retire remaining legacy credentials and shortcuts

- disable legacy subscription token and `/<KEY>` only after section 10.3 gates pass;
- remove any remaining legacy secret-management surfaces;
- confirm legacy admin aliases and old admin-session epochs remain permanently invalid;
- complete Cloudflare least-privilege token handoff and revoke old broad token.

### Optional Phase F — canonical host switch

Only after the current optimizer experiment and a separate ingress baseline decision, optionally set `CANONICAL_EDGE_HOST` to production `workers.dev`, run tunnel/subscription canaries, update `PROBE_HOST`, and treat subsequent ingress measurements as a new baseline.

## 15. Rollback

- Before strict enforcement, rollback keeps the existing primary route while fixing new Access/control-host configuration.
- The identity-boundary cutover MUST NOT roll back by re-enabling legacy `UUID`/`KEY` admin aliases or an old admin-session epoch. If rollback is required, restore an explicit UUID equal to the pre-change tunnel UUID and an explicit independent ADMIN under a fresh/current session epoch.
- After `workers.dev` has been exposed, rollback to any release/configuration lacking strict DATA-only enforcement MUST satisfy section 9.1: disable `workers.dev` before or atomically with the rollback.
- A rollback may keep `workers.dev` enabled only when the rollback target itself enforces the same DATA-only host matrix.
- If a `workers.dev` canary fails while enforcement remains healthy, disable only that route and keep the primary Custom Domain.
- Subscription rollback re-enables bounded read-only legacy token + exact `/<KEY>` overlap; it does not restore admin authority to `KEY`.
- Ops rollback restores NAS control calls only to a previously proven endpoint intentionally supported by the current phase.
- UUID is never rotated for hostname/control-plane rollback; explicitly materialized effective UUID remains the identity anchor.
- Cloudflare broad-token revocation is not undone; rollback uses the new scoped credentials.

## 16. Test and evidence gates

Implementation is not mergeable until all applicable gates pass:

1. host role sets are pairwise disjoint;
2. `CANONICAL_EDGE_HOST` belongs only to DATA;
3. unknown hosts fail before dispatch;
4. complete role-by-sensitive-route negative matrix is tested;
5. primary Custom Domain DATA tunnel/sub/probe works;
6. `workers.dev` cannot become reachable before DATA-only enforcement and rejects foreign control routes from first availability;
7. rollback to a pre-enforcement release is blocked unless `workers.dev` is disabled before/atomically;
8. generated subscriptions use only `CANONICAL_EDGE_HOST`;
9. candidate probing preserves candidate IP + canonical SNI/Host and 65,536-byte contract;
10. Access-protected OPS hostname is not used for ingress scoring;
11. NAS ops calls require Access service credentials + `OPTIMIZER_TOKEN`;
12. NAS DATA probe does not send Access credentials;
13. pre-change effective tunnel UUID is computed before any ADMIN/UUID/legacy-alias mutation that could affect derivation;
14. coupled legacy deployments perform explicit UUID + independent ADMIN + admin-fallback removal + session-epoch rotation atomically, or through a compatibility release with no credential-changing intermediate state;
15. no intermediate state changes tunnel UUID or allows tunnel UUID/KEY/legacy alias to become an admin credential;
16. current effective tunnel UUID is identical before/after materialization and a real tunnel canary proves it;
17. old `UUID`/`KEY`/legacy-alias admin login attempts fail after cutover;
18. admin sessions minted under the old credential/session epoch are rejected after cutover even if their KV records have not expired;
19. new ADMIN sessions succeed only under the current epoch and ADMIN role;
20. mandatory legacy subscription token and exact `/<KEY>` overlap are tested through explicit retirement;
21. existing `/<KEY>` clients are proven migrated before shortcut removal;
22. least-privilege Worker and zone credentials are independently validated;
23. superseded broad Cloudflare token is explicitly revoked;
24. logs/responses expose no credential or session values;
25. existing tunnel protocol tests remain green;
26. Wrangler dry-run succeeds;
27. rollout does not combine hostname migration with Stage C egress or optimizer-v2 scoring changes;
28. current seven-day fixed-seed optimizer experiment remains unchanged.

## 17. Decisions frozen by this revision

- One Worker remains the default topology.
- Every registered hostname has exactly one role; unknown hostnames fail closed.
- Production `workers.dev` is a long-lived DR DATA endpoint and is never public before DATA-only enforcement.
- A rollback to pre-enforcement code cannot leave `workers.dev` public.
- Custom Domain remains default canonical recommendation; canonical host may later switch to production `workers.dev` separately.
- Generated subscriptions use `CANONICAL_EDGE_HOST`.
- Stage B ingress probes stay on DATA Host/SNI via exact bounded probe.
- NAS ops API and probe configuration are separated; Access service credentials apply only to OPS traffic.
- For coupled legacy deployments, pre-change effective UUID is computed before credential mutation and explicit UUID + independent ADMIN + admin fallback removal + session-epoch rotation occur atomically; there is no ADMIN-only intermediate state.
- Old admin sessions are invalidated at the new credential boundary by epoch/namespace rotation or equivalent purge; legacy cookies never survive the separation cutover.
- Current effective tunnel UUID is preserved exactly; this migration never rotates it merely to separate credentials.
- Legacy subscription-token and documented exact `/<KEY>` compatibility overlap is mandatory until client migration is proven.
- Cloudflare least-privilege migration is incomplete until the old broad token is revoked.
- Current seven-day fixed-seed experiment is not altered.

## 18. References checked 2026-08-24

- Cloudflare Workers routes and domains
- Cloudflare Workers `workers.dev`
- Cloudflare Workers Custom Domains
- Cloudflare Access for Workers/hostnames
- Cloudflare Access service tokens

These implementation dependencies MUST be rechecked immediately before production rollout because Cloudflare product behavior may change.
