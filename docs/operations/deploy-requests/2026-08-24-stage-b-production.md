# Stage B production deployment

Date: 2026-08-24

Deploy the Stage B Worker-side optimizer authority and machine API changes from `main` after validation.

Safety invariants for this deployment:

- `FALLBACK_DOMAINS` remains empty.
- `FORCE_EGRESS_DOMAINS` remains empty.
- Stage C private NAS egress is not enabled.
- NAS `PUBLISH_ENABLED` remains an operator-side setting and is not enabled by this deployment.
- Production workflow must run tests, syntax checks, and Wrangler dry-run before deploy.
- The GitHub-hosted external probe remains advisory because Cloudflare may challenge cloud-runner IPs.

Post-deploy authoritative runtime verification is the NAS `optimizer canary` from the real network.
