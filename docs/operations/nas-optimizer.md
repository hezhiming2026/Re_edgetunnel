# NAS Optimizer Runbook

The NAS optimizer measures Cloudflare ingress from the operator's real network and promotes a revisioned ADD pool only after explicit safety gates. It does not need a Cloudflare account token and it does not provide NAS egress; private egress belongs to Stage C.

## Safety model

- The container starts with `PUBLISH_ENABLED=false`.
- `canary` and dry-run modes never mutate the optimizer pool.
- Candidate probes connect to a candidate Cloudflare IPv4 address on port 443 while preserving the configured Worker hostname as TLS SNI and HTTP `Host`.
- TLS certificate verification stays enabled.
- A candidate is eligible only after at least two successful rounds out of three and a median TTFB no greater than 1500 ms.
- The proposed pool contains at most eight entries and at most two entries from any `/24`.
- Fewer than four eligible entries never publish.
- A healthy current pool changes only when the proposed median score improves by at least 15 percent.
- A revision conflict never retries automatically.
- An existing manual ADD override prevents subsequent automatic publication. The first migration may create a shadow optimizer revision beneath the manual override; that requires the handoff procedure below.

## Files and permissions

From the repository root:

```bash
cd deploy/nas
cp optimizer.env.example optimizer.env
mkdir -p optimizer-data
chmod 600 optimizer.env
```

Edit `optimizer.env` and set only the deployment-specific values:

- `WORKER_BASE_URL=https://<worker-hostname>`
- `EDGE_HOSTNAME=<worker-hostname>`
- `OPTIMIZER_TOKEN=<the same machine token configured on the Worker>`

Keep `PUBLISH_ENABLED=false` for the initial rollout. The optimizer does not require `EDGETUNNEL_ADMIN`, a Cloudflare account ID, or a Cloudflare API token.

The image runs as UID/GID `10001`. Ensure the bind-mounted state directory is writable by that identity before starting the daemon. On systems that support normal POSIX ownership:

```bash
sudo chown -R 10001:10001 optimizer-data
```

Use the NAS permission model's equivalent if ownership is managed by the NAS UI.

## Build

```bash
docker compose -f docker-compose.optimizer.yml build
```

The service has no published ports, no host networking, no Linux capabilities, and a read-only root filesystem. Only `/data` is persistent and writable.

## Gate 1: Stage A canary from the NAS

Run the authenticated machine-plane canary from the NAS network:

```bash
docker compose -f docker-compose.optimizer.yml run --rm optimizer canary
```

Expected shape:

```json
{"ok":true,"revision":null,"add_source":"none","probe_bytes":65536}
```

`revision` and `add_source` may already differ on an upgraded deployment. The hard requirements are that authenticated status succeeds and the probe returns exactly 65536 bytes.

If this fails with an edge/WAF response, do not weaken the whole zone merely to make the canary pass. Diagnose the NAS source and the Worker hostname's scoped edge policy first.

## Gate 2: full dry-run

```bash
docker compose -f docker-compose.optimizer.yml run --rm optimizer run --mode full --dry-run
```

This measures approximately 192 candidates, including current winners and configured seeds, for three rounds each. It writes local measurement history but does not publish.

Inspect the state directory:

```bash
ls -lah optimizer-data
ls -lah optimizer-data/runs
cat optimizer-data/history.jsonl
```

A normal dry-run result reports `status: "dry_run"` and a proposed pool. If fewer than four candidates are eligible, investigate the network before enabling publication.

## Gate 3: one-shot controlled publish

Do not edit `optimizer.env` yet. Override publication for one command only:

```bash
docker compose -f docker-compose.optimizer.yml run --rm \
  -e PUBLISH_ENABLED=true \
  optimizer run --mode full
```

Possible important results:

- `published`: the optimizer revision became the effective optimizer ADD source.
- `published_shadow_manual`: a valid optimizer revision was created, but a manual ADD override is still effective. Continue with the manual handoff below.
- `manual_override_active`: an optimizer revision already exists while a manual override is active. Do not repeatedly publish; complete or intentionally retain the manual override.
- `revision_conflict`: another publisher changed the revision. Re-run status/dry-run; never force overwrite.
- `rolled_back`: post-publish verification failed and the just-published revision was rolled back.
- `remote_state_unknown`: the remote revision is not represented in local `/data`; stop and reconcile state instead of guessing.

## Manual override handoff

This gate exists because the browser-admin manual ADD has deliberately higher priority than the optimizer pool.

1. Save a private backup of the current manual ADD text outside the repository.
2. Confirm the one-shot command returned `published_shadow_manual` and note that the optimizer revision exists.
3. Open the existing browser admin ADD editor.
4. Clear the manual ADD contents and save. This removes the override; it does not delete the optimizer revision underneath it.
5. Immediately run:

```bash
docker compose -f docker-compose.optimizer.yml run --rm optimizer canary
```

The result must now show `add_source: "optimizer"`.

6. Refresh the subscription and perform a real client sanity check on known-working destinations.
7. If the client sanity check fails, restore the privately saved manual ADD through the browser admin editor. A restored manual override immediately takes precedence over the optimizer pool.

Do not delete the private backup until the transition has been stable.

## Enable the daemon

Only after canary, full dry-run, controlled publish, handoff (if required), and real-client sanity checks pass, change:

```text
PUBLISH_ENABLED=true
```

Then start the service:

```bash
docker compose -f docker-compose.optimizer.yml up -d --build
```

The daemon performs a full cycle at startup, fast cycles at roughly six-hour intervals, and a full cycle roughly every 24 hours. A filesystem lock prevents overlapping cycles. A stale lock older than two hours is recoverable after an unclean container exit.

## Operations

View logs:

```bash
docker compose -f docker-compose.optimizer.yml logs -f --tail=200 optimizer
```

Force a non-mutating measurement:

```bash
docker compose -f docker-compose.optimizer.yml run --rm optimizer run --mode fast --dry-run
```

Force a full measurement:

```bash
docker compose -f docker-compose.optimizer.yml run --rm optimizer run --mode full --dry-run
```

Run the Stage A machine-plane canary:

```bash
docker compose -f docker-compose.optimizer.yml run --rm optimizer canary
```

Detailed runs are kept for 30 days and compact history for 180 days. `current.json`, `previous.json`, and `last-good-add.txt` are the local restart/recovery state.

## Emergency manual override

If automated ingress becomes suspect, use the existing browser-admin ADD editor to install a known-good manual ADD pool. Manual override has higher priority than optimizer state. While a manual override is active, the daemon continues measuring but does not perform subsequent automatic publications. After the incident is resolved, repeat the controlled handoff before clearing the manual override.
