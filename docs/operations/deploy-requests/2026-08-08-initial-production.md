# Initial production deployment request

Target: `edge.tianbufu.click`
Worker: `tianbufu-edge`
KV namespace: `tianbufu-edge-production`

This file records the first guarded production deployment request. The associated pull request is intentionally used to trigger the production GitHub Actions workflow after repository secrets were configured.

## Security event diagnosis

The first health check reached Cloudflare but received a Managed Challenge from Security Level / Under Attack Mode (`source=securitylevel`, `ruleId=iuam`). The retry applies a hostname-scoped Configuration Rule for `edge.tianbufu.click` that sets only `security_level=off`, leaving the rest of the zone security controls unchanged.

Retry requested after adding the idempotent Configuration Rule automation.
