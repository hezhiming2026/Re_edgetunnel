# Initial production deployment request

Target: `edge.tianbufu.click`
Worker: `tianbufu-edge`
KV namespace: `tianbufu-edge-production`

This file records the first guarded production deployment request. The associated pull request is intentionally used to trigger the production GitHub Actions workflow after repository secrets were configured.

## Security event diagnosis

The first health check reached Cloudflare but received a Managed Challenge from Security Level / Under Attack Mode (`source=securitylevel`, `ruleId=iuam`). The deployment flow applies hostname-scoped exceptions for `edge.tianbufu.click`, leaving the rest of the zone security controls unchanged.

Cloudflare accepted the hostname-scoped `security_level=essentially_off` Configuration Rule and the WAF custom Skip rule for the `Security Level` product. A no-cookie curl from the actual client network returned HTTP/2 200 with no `cf-mitigated` challenge header, confirming the production client path is reachable.

GitHub-hosted Azure runners can still be challenged because cloud-provider IP reputation is not representative of the client network. The external CI probe is therefore advisory; Worker/KV/secret/security-rule deployment remains the hard production gate.
