# edge.tianbufu.click deployment design

Date: 2026-08-06

## Goal

Deploy the repository as a private Cloudflare Worker on `edge.tianbufu.click` without committing credentials, Cloudflare account identifiers, or generated KV identifiers to Git.

## Production resources

- Worker service: `tianbufu-edge`
- Custom Domain: `edge.tianbufu.click`
- KV namespace: `tianbufu-edge-production`
- KV binding: `KV`
- Public `workers.dev` endpoint: disabled

## Deployment flow

1. A manually triggered GitHub Actions workflow validates the repository.
2. The workflow lists Cloudflare KV namespaces and reuses `tianbufu-edge-production` when it already exists.
3. If the namespace does not exist, the workflow creates it through the Cloudflare API.
4. The workflow writes the returned namespace ID to an ignored, generated `wrangler.deploy.toml` file.
5. The official Cloudflare Wrangler action uploads `ADMIN` and `UUID` as Worker secrets and deploys the Worker.
6. Wrangler attaches `edge.tianbufu.click` as a Custom Domain. Cloudflare owns DNS record and certificate provisioning for that hostname.
7. The workflow checks that the root endpoint responds over HTTPS.

## Trust boundaries

- GitHub contains only source code and non-secret deployment configuration.
- Cloudflare account credentials are stored as GitHub Actions secrets.
- `ADMIN` and `UUID` are stored as GitHub Actions secrets and uploaded as Cloudflare Worker secrets.
- The generated KV namespace ID is not treated as a credential, but it is kept out of the committed configuration to allow idempotent account-specific provisioning.
- Deployment is manual rather than automatic on every push, reducing accidental production changes.

## Node-selection model

`ADD.txt` is the curated ingress address pool. Candidate addresses must be measured from the network that actually uses the tunnel, not from GitHub-hosted runners. The Worker expands the saved addresses into subscription nodes; the client performs ongoing health checking and selects among them.

Recommended production pool:

- 4 to 8 measured Cloudflare addresses.
- Port 443 initially.
- Separate measurements for materially different access networks.
- Weekly refresh when stable; daily refresh when routes are volatile.
- No unreviewed public address or ProxyIP feeds.

## Failure handling

- Source validation failure stops before Cloudflare changes.
- KV API failure stops before deployment.
- An existing namespace is reused, so repeated deployments do not create duplicate storage.
- A custom-domain conflict is surfaced by Wrangler and does not silently replace an unrelated hostname.
- The existing Worker deployment remains available if a new deployment fails before activation.

## Rollback

Use Cloudflare Workers deployment history to restore the previous Worker version. The KV namespace is not deleted by rollback or failed deployment, so configuration and sessions remain available. Removing the `routes` block in a later deployment detaches the custom domain but does not delete the Worker or KV namespace.

## Non-goals

- Automatically benchmarking Cloudflare addresses from GitHub Actions.
- Importing third-party ProxyIP pools.
- Enabling public subscription conversion services.
- Making the deployment workflow continuously deploy every commit to `main`.
