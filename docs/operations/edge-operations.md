# Edge operations — Stage A contracts and diagnostics

This runbook validates the Stage A machine API and diagnostic contracts without enabling automatic ingress publishing or private NAS fallback.

Use environment variables rather than committing production identifiers:

```bash
export EDGE_BASE_URL='https://<edge-hostname>'
export OPTIMIZER_TOKEN='<machine-token>'
export ADMIN_PASSWORD='<browser-admin-password>'
```

The production deployment secret is stored in GitHub as `EDGETUNNEL_OPTIMIZER_TOKEN` and uploaded to the Worker as `OPTIMIZER_TOKEN`. It must be at least 24 characters. Do not reuse `ADMIN`, `UUID`, or a Cloudflare API token.

## Stage A invariants

- `FALLBACK_DOMAINS` is empty.
- `FORCE_EGRESS_DOMAINS` is empty.
- `DIAGNOSTIC_TARGETS` contains no committed production hostnames. Configure target keys only in controlled deployment configuration when canary diagnostics are required.
- Machine API publishing accepts only the committed Cloudflare IPv4 allowlist on port 443.
- Egress observation is diagnostic-only; an 8-second first-byte event does not close, retry, or reroute the connection.

## Authentication isolation

Unauthenticated machine route must return HTTP 401:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$EDGE_BASE_URL/ops/optimizer/v1/status"
# expected: 401
```

The browser-admin password must not authenticate machine routes:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  "$EDGE_BASE_URL/ops/optimizer/v1/status"
# expected: 401
```

The machine token must not authorize browser-admin routes. Without a valid admin session cookie, `/admin` must redirect to login rather than grant access:

```bash
curl -sS -D - -o /dev/null \
  -H "Authorization: Bearer $OPTIMIZER_TOKEN" \
  "$EDGE_BASE_URL/admin"
# expected: HTTP 302 with Location: /login
```

## Bounded ingress probe

```bash
probe_file="$(mktemp)"
trap 'rm -f "$probe_file"' EXIT

curl -sS \
  -H "Authorization: Bearer $OPTIMIZER_TOKEN" \
  "$EDGE_BASE_URL/ops/optimizer/v1/probe" \
  -o "$probe_file"

wc -c < "$probe_file"
# expected: 65536
```

The response must include `Cache-Control: no-store` and `X-Optimizer-Probe-Version: 1`.

## Revision-safe pool canary

Do not run this section against production until a controlled canary pool is approved. The examples use documentation-only Cloudflare-shaped placeholders; replace them only with measured addresses from the configured allowlist.

Read current revision:

```bash
curl -sS \
  -H "Authorization: Bearer $OPTIMIZER_TOKEN" \
  "$EDGE_BASE_URL/ops/optimizer/v1/status"
```

A publish request contains both `expected_current_revision` and structured `entries`; raw `ADD.txt` is never accepted by the machine API.

After one successful controlled publish, repeat a request using the old revision. It must return HTTP 409 and must not change either `optimizer:current` or `ADD.txt`.

Rollback must use the exact current revision:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $OPTIMIZER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"expected_current_revision":"<current-revision>"}' \
  "$EDGE_BASE_URL/ops/optimizer/v1/rollback"
```

After rollback, verify `optimizer:current` points to the previous immutable snapshot and the subscription materializes the restored `ADD.txt` pool.

## Egress diagnostic canary

Synthetic diagnostics accept only a configured target key:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $OPTIMIZER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"target":"<configured-key>"}' \
  "$EDGE_BASE_URL/ops/egress/v1/diagnose"
```

Stage A response reports only the target key, direct TCP state/timing, and `nas.state=not_configured`. It does not return the configured hostname and does not send an application request to the target.

For real proxy sessions, configured diagnostic targets may emit only bounded events such as `direct_open_ok`, `direct_open_error`, `direct_closed_before_byte`, `direct_first_byte_ok`, and `direct_first_byte_timeout`, with target key and elapsed time. They must remain direct-only in Stage A.

## Exit gate

Stage A is ready for the next stage only when all of these are true:

1. `npm test` and `npm run check` pass.
2. Authentication isolation checks above pass.
3. Probe returns exactly 65536 bytes.
4. Revision conflict returns 409 with no pool mutation.
5. Controlled rollback restores the previous pool.
6. `FALLBACK_DOMAINS` and `FORCE_EGRESS_DOMAINS` remain empty.
7. Diagnostic events contain only configured target keys and bounded timing metadata.
8. A known-good direct destination remains functional from the real client.

Do not interpret a spinning destination page alone as proof of a Cloudflare egress block. Compare real-session direct events with the later private NAS path before enabling any fallback rule.
