#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

KV_NAMESPACE_TITLE="${KV_NAMESPACE_TITLE:-tianbufu-edge-production}"
API_ROOT="https://api.cloudflare.com/client/v4"
AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

list_response="$({
  curl --silent --show-error --fail-with-body \
    --header "${AUTH_HEADER}" \
    --header "Content-Type: application/json" \
    "${API_ROOT}/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces?per_page=100"
} 2>&1)" || {
  printf 'Failed to list Cloudflare KV namespaces.\n%s\n' "${list_response}" >&2
  exit 1
}

if [[ "$(jq -r '.success // false' <<<"${list_response}")" != "true" ]]; then
  printf 'Cloudflare KV namespace listing failed.\n%s\n' "${list_response}" >&2
  exit 1
fi

kv_id="$(jq -r --arg title "${KV_NAMESPACE_TITLE}" '.result[]? | select(.title == $title) | .id' <<<"${list_response}" | head -n 1)"

if [[ -z "${kv_id}" ]]; then
  payload="$(jq -nc --arg title "${KV_NAMESPACE_TITLE}" '{title: $title}')"
  create_response="$({
    curl --silent --show-error --fail-with-body \
      --request POST \
      --header "${AUTH_HEADER}" \
      --header "Content-Type: application/json" \
      --data "${payload}" \
      "${API_ROOT}/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces"
  } 2>&1)" || {
    printf 'Failed to create Cloudflare KV namespace.\n%s\n' "${create_response}" >&2
    exit 1
  }

  if [[ "$(jq -r '.success // false' <<<"${create_response}")" != "true" ]]; then
    printf 'Cloudflare KV namespace creation failed.\n%s\n' "${create_response}" >&2
    exit 1
  fi

  kv_id="$(jq -r '.result.id // empty' <<<"${create_response}")"
fi

if [[ ! "${kv_id}" =~ ^[0-9a-fA-F]{32}$ ]]; then
  printf 'Cloudflare returned an invalid KV namespace ID.\n' >&2
  exit 1
fi

python3 - "${kv_id}" <<'PY'
from pathlib import Path
import sys

namespace_id = sys.argv[1]
source = Path("wrangler.toml")
target = Path("wrangler.deploy.toml")
text = source.read_text(encoding="utf-8")
placeholder = 'id = "your-kv-id-here"'
if text.count(placeholder) != 1:
    raise SystemExit("Expected exactly one KV namespace placeholder in wrangler.toml")
target.write_text(text.replace(placeholder, f'id = "{namespace_id}"'), encoding="utf-8")
PY

printf 'Prepared wrangler.deploy.toml with KV namespace %s.\n' "${KV_NAMESPACE_TITLE}"
