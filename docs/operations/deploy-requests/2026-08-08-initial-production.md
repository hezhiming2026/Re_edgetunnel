# Initial production deployment request

Target: `edge.tianbufu.click`
Worker: `tianbufu-edge`
KV namespace: `tianbufu-edge-production`

This file records the first guarded production deployment request. The associated pull request is intentionally used to trigger the production GitHub Actions workflow after repository secrets were configured.

## Security event diagnosis

The first health check reached Cloudflare but received a Managed Challenge from Security Level / Under Attack Mode (`source=securitylevel`, `ruleId=iuam`). The deployment flow applies hostname-scoped exceptions for `edge.tianbufu.click`, leaving the rest of the zone security controls unchanged.

The API token has Config Rules Edit. Cloudflare accepted `security_level=essentially_off`, and normal Safari/Chrome access no longer presents a visible challenge, but GitHub's Azure runner is still challenged. The final retry adds a WAF custom Skip rule that bypasses only the `Security Level` product for this hostname. The automation also preserves the immutable Cloudflare rule reference ID when updating the existing configuration rule.
