# edge.tianbufu.click production runbook

## Resulting Cloudflare resources

| Resource | Value |
| --- | --- |
| Worker | `tianbufu-edge` |
| Custom Domain | `edge.tianbufu.click` |
| KV namespace | `tianbufu-edge-production` |
| KV binding | `KV` |

The Custom Domain deployment creates the required DNS record and certificate through Cloudflare. Do not pre-create a CNAME record for `edge.tianbufu.click`; an existing CNAME conflicts with Custom Domain creation.

## Required GitHub Actions secrets

Create these repository secrets before running the workflow:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account containing `tianbufu.click` |
| `CLOUDFLARE_API_TOKEN` | Restricted deployment token |
| `EDGETUNNEL_ADMIN` | Administrator login password |
| `EDGETUNNEL_UUID` | RFC 4122 version-4 VLESS/Trojan credential |

Use the Cloudflare **Edit Cloudflare Workers** token template and restrict it to the account and the `tianbufu.click` zone. The workflow needs Workers Scripts write, Workers KV Storage write, and Workers Routes write permissions.

Generate credentials locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('node:crypto').randomUUID())"
```

Store the first value as `EDGETUNNEL_ADMIN` and the second as `EDGETUNNEL_UUID`. Do not reuse either value elsewhere.

## Deploy

1. Open the repository on GitHub.
2. Open **Actions**.
3. Select **Deploy Cloudflare Worker**.
4. Select **Run workflow** from the `main` branch after the deployment PR is merged.
5. Confirm that all steps succeed, including **Verify custom domain**.

The workflow is intentionally manual. A normal source push does not change production.

## First login

Open:

```text
https://edge.tianbufu.click/login
```

Sign in with `EDGETUNNEL_ADMIN`, then open:

```text
https://edge.tianbufu.click/admin
```

Retrieve the generated subscription token from `/admin/config.json`. Treat the complete subscription URL as a credential.

## Maintain the ingress address pool

The Worker reads the curated address list from KV key `ADD.txt`. Each line uses:

```text
address:port#display name
```

Example format:

```text
104.16.10.20:443#Home-01
104.17.20.30:443#Home-02
```

Only use addresses measured from the access network that will use the tunnel. GitHub-hosted runner measurements are not representative of the user's ISP path.

Recommended policy:

- Retain 4 to 8 working addresses.
- Prefer port 443 until there is evidence another TLS port is more reliable.
- Remove candidates with repeated TLS failures or material packet loss.
- Refresh weekly when stable and daily when the route changes frequently.
- Let Mihomo or Sing-box health-check the saved candidates and select the current best node.
- Do not place public ProxyIP or address feeds into production without independent review.

After login, update `ADD.txt` from the browser console:

```js
const addresses = `104.16.10.20:443#Home-01
104.17.20.30:443#Home-02`;

const response = await fetch('/admin/ADD.txt', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: addresses,
});

console.log(response.status, await response.text());
```

## Rollback

Use the Cloudflare Worker deployment history to restore the previous version. The production KV namespace is reused and is not deleted by a code rollback.

To detach the hostname, remove the `[[routes]]` Custom Domain block from `wrangler.toml` and deploy again. This does not delete the Worker or its KV namespace.
