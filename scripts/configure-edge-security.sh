#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

ZONE_NAME="${ZONE_NAME:-tianbufu.click}"
EDGE_HOSTNAME="${EDGE_HOSTNAME:-edge.tianbufu.click}"
API_ROOT="https://api.cloudflare.com/client/v4"
AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
RULE_REF="edgetunnel_security_level_off"

cf_request() {
  local method="$1"
  local endpoint="$2"
  local payload="${3:-}"
  local response

  if [[ -n "$payload" ]]; then
    response="$({
      curl --silent --show-error --fail-with-body \
        --request "$method" \
        --header "$AUTH_HEADER" \
        --header "Content-Type: application/json" \
        --data "$payload" \
        "${API_ROOT}${endpoint}"
    } 2>&1)" || {
      printf 'Cloudflare API request failed: %s %s\n%s\n' "$method" "$endpoint" "$response" >&2
      return 1
    }
  else
    response="$({
      curl --silent --show-error --fail-with-body \
        --request "$method" \
        --header "$AUTH_HEADER" \
        --header "Content-Type: application/json" \
        "${API_ROOT}${endpoint}"
    } 2>&1)" || {
      printf 'Cloudflare API request failed: %s %s\n%s\n' "$method" "$endpoint" "$response" >&2
      return 1
    }
  fi

  if [[ "$(jq -r '.success // false' <<<"$response")" != "true" ]]; then
    printf 'Cloudflare API returned success=false: %s %s\n%s\n' "$method" "$endpoint" "$response" >&2
    return 1
  fi

  printf '%s' "$response"
}

zone_query="/zones?name=${ZONE_NAME}&account.id=${CLOUDFLARE_ACCOUNT_ID}&per_page=50"
zone_response="$(cf_request GET "$zone_query")" || {
  echo 'Unable to resolve the zone ID. The API token needs Zone -> Zone -> Read for tianbufu.click.' >&2
  exit 1
}

zone_id="$(jq -r --arg zone "$ZONE_NAME" --arg account "$CLOUDFLARE_ACCOUNT_ID" \
  '.result[]? | select(.name == $zone and .account.id == $account) | .id' <<<"$zone_response" | head -n 1)"

if [[ ! "$zone_id" =~ ^[0-9a-fA-F]{32}$ ]]; then
  echo "Could not find zone ${ZONE_NAME} in the configured Cloudflare account." >&2
  exit 1
fi

rulesets_response="$(cf_request GET "/zones/${zone_id}/rulesets")" || {
  echo 'Unable to read Configuration Rules. Add Config Settings Read/Write or Zone WAF Read/Write to the API token.' >&2
  exit 1
}

ruleset_id="$(jq -r '.result[]? | select(.kind == "zone" and .phase == "http_config_settings") | .id' \
  <<<"$rulesets_response" | head -n 1)"

rule_payload="$(jq -nc --arg host "$EDGE_HOSTNAME" --arg ref "$RULE_REF" '{
  action: "set_config",
  expression: ("http.host eq \"" + $host + "\""),
  description: "Disable Under Attack/Security Level challenge only for the EdgeTunnel hostname",
  ref: $ref,
  enabled: true,
  action_parameters: {security_level: "essentially_off"}
}')"

if [[ -z "$ruleset_id" ]]; then
  create_payload="$(jq -nc --argjson rule "$rule_payload" '{
    name: "tianbufu configuration rules",
    description: "Hostname-scoped Cloudflare configuration overrides managed by Re_edgetunnel",
    kind: "zone",
    phase: "http_config_settings",
    rules: [$rule]
  }')"

  cf_request POST "/zones/${zone_id}/rulesets" "$create_payload" >/dev/null || {
    echo 'Unable to create the Configuration Rule. The current Cloudflare plan may not permit this Security Level override.' >&2
    exit 1
  }
  echo "Created Security Level override for ${EDGE_HOSTNAME} (essentially_off)."
  exit 0
fi

ruleset_response="$(cf_request GET "/zones/${zone_id}/rulesets/${ruleset_id}")"
rule_id="$(jq -r --arg ref "$RULE_REF" '.result.rules[]? | select(.ref == $ref) | .id' <<<"$ruleset_response" | head -n 1)"

if [[ -n "$rule_id" ]]; then
  cf_request PATCH "/zones/${zone_id}/rulesets/${ruleset_id}/rules/${rule_id}" "$rule_payload" >/dev/null || {
    echo 'Unable to update the Configuration Rule. The current Cloudflare plan may not permit this Security Level override.' >&2
    exit 1
  }
  echo "Updated Security Level override for ${EDGE_HOSTNAME} (essentially_off)."
else
  cf_request POST "/zones/${zone_id}/rulesets/${ruleset_id}/rules" "$rule_payload" >/dev/null || {
    echo 'Unable to add the Configuration Rule. The current Cloudflare plan may not permit this Security Level override.' >&2
    exit 1
  }
  echo "Added Security Level override for ${EDGE_HOSTNAME} (essentially_off)."
fi
