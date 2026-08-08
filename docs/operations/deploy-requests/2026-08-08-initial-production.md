# Initial production deployment request

Target: `edge.tianbufu.click`
Worker: `tianbufu-edge`
KV namespace: `tianbufu-edge-production`

This file records the first guarded production deployment request. The associated pull request is intentionally used to trigger the production GitHub Actions workflow after repository secrets were configured.

## Security event diagnosis

The first health check reached Cloudflare but received a Managed Challenge from Security Level / Under Attack Mode (`source=securitylevel`, `ruleId=iuam`). The deployment flow applies a hostname-scoped Configuration Rule for `edge.tianbufu.click`, leaving the rest of the zone security controls unchanged.

The API token now has Config Rules Edit. Cloudflare accepted the permission but rejected `security_level=off` as not entitled for the current plan, so the retry uses the documented `essentially_off` value instead.
