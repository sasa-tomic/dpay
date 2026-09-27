# shellcheck shell=bash
# Shared deploy/.env read/write for the dpay deploy scripts (tunnel-provision.sh, dfx-deploy-ic.sh).
# Sourced, not executed. One place that knows how to edit deploy/.env in place, so each script does
# not reimplement it: every other line is preserved; a key is replaced if present, appended if not.
#
# deploy/.env is GENERATED (scripts/gen-deploy-env.sh) from deploy/env.config (tracked, non-secret)
# + secrets/*.sops.json (sops). Sourcing this file auto-regenerates it when stale and fails closed
# (naming the exact fix) when sops is unusable — no deploy path may run against a stale or missing
# .env. Set DPAY_ENV_SYNC=0 to skip (hermetic tests, offline tooling). New values are persisted to
# their SOURCE with env_set_sops (secrets) / env_set_config (non-secret), never into .env by hand.

ENV_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_ROOT="$(dirname "$ENV_LIB_DIR")"
ENV_SOPS_DEPLOY="$ENV_ROOT/secrets/deploy.sops.json"

# env_sync — regenerate deploy/.env when its sources changed (no-op when fresh).
env_sync() {
  bash "$ENV_ROOT/scripts/gen-deploy-env.sh" -q
}

# env_set_sops KEY VALUE — persist a SECRET to secrets/deploy.sops.json (sops-encrypted) and
# regenerate deploy/.env. Creates the file on first use.
env_set_sops() {
  local key="$1" value="$2"
  local age="${SOPS_AGE_KEY_FILE:-$ENV_ROOT/.dev/age/agent-key.txt}"
  command -v sops >/dev/null 2>&1 || { echo "env_set_sops: sops is not on PATH — install it (github.com/getsops/sops)" >&2; return 1; }
  if [ ! -s "$ENV_SOPS_DEPLOY" ]; then
    local tmp; tmp="$(mktemp)"
    SOPS_AGE_KEY_FILE="$age" sops --encrypt --input-type json \
      --filename-override "$ENV_SOPS_DEPLOY" /dev/stdin >"$tmp" <<< '{}'
    mv "$tmp" "$ENV_SOPS_DEPLOY"
    echo "   created secrets/deploy.sops.json (sops-encrypted)"
  fi
  # sops set --value-stdin takes the JSON-ENCODED value on stdin (kept off argv/process listings).
  if ! SOPS_AGE_KEY_FILE="$age" sops set --value-stdin "$ENV_SOPS_DEPLOY" \
      "$(jq -nr --arg k "$key" '"[\($k|tojson)]"')" \
      <<<"$(jq -nr --arg v "$value" '$v|tojson')" >/dev/null; then
    echo "env_set_sops: FAILED to store $key in secrets/deploy.sops.json — is the age key readable ($age)? Fix: sops secrets/deploy.sops.json" >&2
    return 1
  fi
  echo "   stored $key in secrets/deploy.sops.json (sops)"
  env_sync
}

# env_set_config KEY VALUE — persist a NON-SECRET config key to deploy/env.config (tracked) and
# regenerate deploy/.env.
env_set_config() {
  local key="$1" value="$2" file="$ENV_ROOT/deploy/env.config"
  env_set "$key" "$value" "$file"
  chmod 644 "$file"
  env_sync
}

# env_get KEY FILE  ->  prints KEY's value (text after the first '='), empty if absent. Last wins.
env_get() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n1
}

# env_set KEY VALUE FILE  ->  set KEY=VALUE in FILE. Creates FILE from a sibling .env.example if it
# is missing, replaces an existing KEY= line in place, appends otherwise, and keeps FILE mode 600.
env_set() {
  local key="$1" value="$2" file="$3"
  if [ ! -f "$file" ]; then
    local example
    example="$(dirname "$file")/.env.example"
    if [ -f "$example" ]; then cp "$example" "$file"; else : >"$file"; fi
  fi
  local tmp; tmp="$(mktemp)"
  # keep every line that isn't this key; grep exit 1 (no match) is fine, any other non-zero aborts.
  grep -v "^${key}=" "$file" >"$tmp" || [ "$?" -eq 1 ]
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}

# Deploy-path gate: every script that sources env-lib is about to read deploy/.env — regenerate
# it first when stale. Fails closed (gen-deploy-env names the exact fix) when sops is missing,
# undecryptable, or a required secret vanished. DPAY_ENV_SYNC=0 skips (hermetic tests).
if [ "${DPAY_ENV_SYNC:-1}" = "1" ]; then
  env_sync
fi
