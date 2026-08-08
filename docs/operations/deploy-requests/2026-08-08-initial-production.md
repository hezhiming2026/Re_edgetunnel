# Initial production deployment result

Target: `edge.tianbufu.click`
Worker: `tianbufu-edge`
KV namespace: `tianbufu-edge-production`
Deployment date: 2026-08-08

## Result

The Cloudflare Worker deployment is operational.

Confirmed deployment components:

- Worker uploaded and bound to the Custom Domain `edge.tianbufu.click`.
- KV namespace `tianbufu-edge-production` provisioned/reused.
- Runtime secrets `ADMIN` and `UUID` uploaded through GitHub Actions.
- Hostname-scoped Configuration Rule sets `security_level=essentially_off` for `edge.tianbufu.click`.
- Hostname-scoped WAF custom Skip rule skips only the `Security Level` product for `edge.tianbufu.click`.
- Source tests and syntax checks pass.
- Final deployment workflow completed successfully.

Final observed Worker version ID: `17001f68-9b6f-401e-a6b0-05db2dcb98f4`.

## Reachability verification

The authoritative client-network verification was a no-cookie curl from the actual client network:

```text
HTTP/2 200
cf-ray: a27e6581299e3512-SEA
```

No `cf-mitigated: challenge` header was present, confirming the real client path reaches the Worker without a Cloudflare Challenge page.

GitHub-hosted Azure runners may still receive a Cloudflare Challenge because cloud-provider IP reputation is materially different from the real client network. The external CI probe is therefore advisory and does not fail an otherwise successful Worker/KV/security-rule deployment.

## Initial incident

The first GitHub-hosted probe was challenged by Cloudflare Security Level / Under Attack Mode (`source=securitylevel`, `ruleId=iuam`). The deployment automation was hardened to keep the EdgeTunnel hostname exceptions scoped only to `edge.tianbufu.click`, without lowering security for the rest of `tianbufu.click`.
