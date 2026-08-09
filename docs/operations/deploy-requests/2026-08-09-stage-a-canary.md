# Stage A Canary Deployment Request

Date: 2026-08-09

Purpose: deploy the approved B2 Stage A contracts and diagnostics changes to production for observation-only canary validation.

## Scope

Enabled by this deployment:
- machine-only `/ops/*` authentication
- SQLite-backed Durable Object optimizer authority
- revision/current/previous/snapshot handling and rollback contract
- bounded ingress probe
- allowlisted synthetic egress diagnostics
- observation-only direct open / first-byte lifecycle events

Explicitly not enabled:
- NAS egress
- automatic egress fallback
- force-egress routing
- automatic ingress pool publishing by a NAS optimizer
- production routing changes based on diagnostic observations

## Preconditions

- Stage A implementation merged to `main`.
- Main validation is green.
- Required private runtime secrets are configured in GitHub Actions.
- `FALLBACK_DOMAINS` and `FORCE_EGRESS_DOMAINS` remain empty.

## Canary gates

Deployment is acceptable only if:
1. source tests and syntax checks pass;
2. Wrangler production bundle validation passes;
3. the Worker deploy step succeeds;
4. existing login/subscription/tunnel behavior remains functional;
5. optimizer and diagnostic endpoints remain machine-authenticated;
6. diagnostic observation remains non-routing and direct-only.

This record intentionally contains no production hostname, account identifier, tunnel identifier, private address, or secret value.
