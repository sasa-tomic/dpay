#!/usr/bin/env bash
# shellcheck shell=bash
# Generate deploy/.env from its two sources:
#   1. deploy/env.config        — tracked, NON-SECRET configuration (verbatim, comments kept)
#   2. secrets/*.sops.json      — sops-encrypted secrets (decrypted here, never logged)
#
# deploy/.env is machine-generated: it carries a gen-stamp (hash of all sources + this script).
# Fresh  → nothing is written. Stale/missing → regenerated atomically, mode 600.
# `--check` exits 3 when stale (deploy paths can gate on it); `--force` regenerates regardless.
# Manual edits to deploy/.env are overwritten on the next regen — edit the sops source instead:
#   sops secrets/<file>.sops.json   →   just deploy-env
#
# Prints only the KEY NAMES it emitted — never a value.
set -euo pipefail

MODE=""
for arg in "$@"; do
  case "$arg" in
    -q|--quiet) MODE="quiet" ;;
    --check)    MODE="check" ;;
    --force)    MODE="force" ;;
    *) echo "usage: $0 [--check|--force|-q]" >&2; exit 1 ;;
  esac
done

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SELF_DIR")"
ENV_FILE="$ROOT/deploy/.env"
CONFIG_FILE="$ROOT/deploy/env.config"
SOPS_DIR="$ROOT/secrets"
AGE_KEY="${SOPS_AGE_KEY_FILE:-$ROOT/.dev/age/agent-key.txt}"

# --- mapping: every emitted var traces to exactly one line here --------------
# SOPS_FILE | JSON_KEY | ENV_NAME | required
# "required" = if the sops file exists but the key is absent/undecryptable, fail naming the fix.
# NOTE on deliberate skips (no consumer in the repo — files stay in sops for future use):
#   stealthex.sops.json STEALTH_EX_API_KEY   (relay has no StealthEx routes)
#   trocador-pg.sops.json DPAY_TROCADOR_PG_DSN_DEV (dev DSN; nothing reads it)
# SideShift's sops keys are renamed here (sops store them account_id/secret; the relay reads
# DPAY_SIDESHIFT_AFFILIATE_ID / DPAY_SIDESHIFT_SECRET).
MAPPING=(
  "deploy.sops.json|CF_TUNNEL_TOKEN|CF_TUNNEL_TOKEN|required"
  "deploy.sops.json|CF_API_TOKEN|CF_API_TOKEN|optional"
  "deploy.sops.json|DPAY_SOLANA_RPC_URL|DPAY_SOLANA_RPC_URL|required"
  "deploy.sops.json|DPAY_CONTROLLER_SEED|DPAY_CONTROLLER_SEED|required"
  "sideshift.sops.json|account_id|DPAY_SIDESHIFT_AFFILIATE_ID|optional"
  "sideshift.sops.json|secret|DPAY_SIDESHIFT_SECRET|optional"
  "trocador.sops.json|DPAY_TROCADOR_API_KEY|DPAY_TROCADOR_API_KEY|optional"
  "trocador-pg.sops.json|DPAY_TROCADOR_PG_DSN|DPAY_TROCADOR_PG_DSN|optional"
  "mtpelerin.sops.json|DPAY_MTPELERIN_CTKN|DPAY_MTPELERIN_CTKN|optional"
  "mtpelerin.sops.json|DPAY_MTPELERIN_WEBHOOK_SECRET|DPAY_MTPELERIN_WEBHOOK_SECRET|optional"
  "mtpelerin.sops.json|DPAY_MTPELERIN_WEBHOOK_AUTH_KEY|DPAY_MTPELERIN_WEBHOOK_AUTH_KEY|optional"
)

# EVM JSON-RPC upstreams (DPAY_EVM_RPC_URL = default chain; DPAY_EVM_RPC_URL_<CHAINID> =
# that chain, e.g. 42161 Arbitrum One / 421614 Arbitrum Sepolia). Values embed api keys →
# SECRETS: they live in secrets/deploy.sops.json under the same names and are emitted here
# wholesale (the chain-id set is open-ended, so it cannot be a fixed mapping row). Absent →
# the EVM route answers 503 naming the variable (legal deploy state).
EVM_RPC_PREFIX="DPAY_EVM_RPC_URL"

fail() { echo "gen-deploy-env: FAIL — $*" >&2; exit 1; }

command -v sops >/dev/null 2>&1 \
  || fail "sops is not on PATH — install it (https://github.com/getsops/sops); it decrypts secrets/*.sops.json to generate deploy/.env"
command -v jq >/dev/null 2>&1 \
  || fail "jq is not on PATH — install it; gen-deploy-env uses it to read the sops JSON"
[ -f "$CONFIG_FILE" ] \
  || fail "$CONFIG_FILE is missing — it is tracked, restore it: git checkout deploy/env.config"
[ -f "$AGE_KEY" ] \
  || fail "age identity missing at $AGE_KEY — restore it from your password manager; it decrypts secrets/*.sops.json (see .sops.yaml header)"

# stamp = hash over the generator itself, the tracked config, sops rules, and every sops
# file's CIPHERTEXT bytes. Any source change flips it; touching a file without changing
# bytes does not (mtime is irrelevant — content is what matters).
stamp() {
  local f
  {
    sha256sum "$SELF_DIR/gen-deploy-env.sh" "$CONFIG_FILE" "$ROOT/.sops.yaml" 2>/dev/null || true
    for f in "$SOPS_DIR"/*.sops.json; do [ -f "$f" ] && sha256sum "$f"; done
  } | sha256sum | cut -d' ' -f1
}

CUR_STAMP="$(stamp)"

if [ "$MODE" != "force" ] && [ -f "$ENV_FILE" ]; then
  FILE_STAMP="$(sed -n 's/^# gen-stamp: //p' "$ENV_FILE" | tail -1)"
  if [ -n "$FILE_STAMP" ] && [ "$FILE_STAMP" = "$CUR_STAMP" ]; then
    exit 0   # fresh — nothing to do
  fi
fi

if [ "$MODE" = "check" ]; then
  echo "gen-deploy-env: deploy/.env is MISSING or STALE (sources changed) — run: just deploy-env" >&2
  exit 3
fi

# --- regenerate --------------------------------------------------------------
TMP="$(mktemp "$ROOT/deploy/.env.gen.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"

EMITTED=""
BOOTSTRAP=0

{
  echo "# ============================================================================="
  echo "# AUTO-GENERATED — DO NOT EDIT. Manual changes are overwritten on the next deploy."
  echo "# Generated by: scripts/gen-deploy-env.sh   (or: just deploy-env; every deploy"
  echo "# path regenerates this file automatically when its sources changed)"
  echo "# Sources:      deploy/env.config (tracked, non-secret config)"
  echo "#               secrets/*.sops.json (sops-encrypted secrets)"
  echo "# To change a secret:  sops secrets/<file>.sops.json   →   just deploy-env"
  echo "# ============================================================================="
} >"$TMP"

{
  echo ""
  echo "# --- config (deploy/env.config, tracked) ---"
  cat "$CONFIG_FILE"
  echo ""
  echo "# --- secrets (decrypted from secrets/*.sops.json at generation time) ---"
} >>"$TMP"

for spec in "${MAPPING[@]}"; do
  IFS='|' read -r SFIELD SKEY EKEY REQ <<<"$spec"
  SF="$SOPS_DIR/$SFIELD"
  if [ ! -f "$SF" ]; then
    if [ "$SFIELD" = "deploy.sops.json" ]; then
      # Bootstrap state: a fresh checkout has no deploy secrets yet; tunnel-provision
      # creates the file when it provisions the tunnel. Warn loudly, keep going.
      echo "gen-deploy-env: WARNING secrets/deploy.sops.json does not exist yet — deploy secrets skipped." >&2
      echo "gen-deploy-env:   bootstrap with 'just tunnel-provision' (stores CF_TUNNEL_TOKEN in sops), or create the file: sops secrets/deploy.sops.json" >&2
      echo "# (secrets/deploy.sops.json does not exist yet — run 'just tunnel-provision' to bootstrap)" >>"$TMP"
      BOOTSTRAP=1
      continue
    fi
    fail "secrets/$SFIELD is missing (need key '$SKEY' → $EKEY) — it is tracked in git; restore it: git checkout secrets/$SFIELD"
  fi
  VAL="$(SOPS_AGE_KEY_FILE="$AGE_KEY" sops -d "$SF" 2>/dev/null | jq -er --arg k "$SKEY" '.[$k] // empty' 2>/dev/null)" || {
    if [ "$REQ" = "required" ]; then
      fail "key '$SKEY' (env $EKEY) is absent or secrets/$SFIELD is undecryptable — open and fix the file: sops secrets/$SFIELD   (age identity: $AGE_KEY)"
    fi
    echo "# ($EKEY: absent from secrets/$SFIELD — skipped)" >>"$TMP"
    continue
  }
  printf '%s=%s\n' "$EKEY" "$VAL" >>"$TMP"
  EMITTED+="$EKEY "
  unset VAL
done

echo "" >>"$TMP"

# --- EVM RPC upstreams (secret pattern, see EVM_RPC_PREFIX above) -------------
if [ -f "$SOPS_DIR/deploy.sops.json" ]; then
  while read -r EKEY B64; do
    [ -n "${EKEY:-}" ] || continue
    VAL="$(printf '%s' "$B64" | base64 -d)"
    printf '%s=%s\n' "$EKEY" "$VAL" >>"$TMP"
    EMITTED+="$EKEY "
    unset VAL
  done < <(SOPS_AGE_KEY_FILE="$AGE_KEY" sops -d "$SOPS_DIR/deploy.sops.json" 2>/dev/null \
    | jq -r --arg p "$EVM_RPC_PREFIX" \
        'to_entries[] | select(.key == $p or (.key | startswith($p + "_"))) | .key + " " + (.value | @base64)' \
        2>/dev/null)
fi

echo "# gen-stamp: $CUR_STAMP" >>"$TMP"

# Idempotence guard: only replace the file when content actually differs.
if [ -f "$ENV_FILE" ] && cmp -s "$TMP" "$ENV_FILE"; then
  exit 0
fi
mv "$TMP" "$ENV_FILE"
trap - EXIT

if [ "$BOOTSTRAP" = "1" ]; then
  echo "gen-deploy-env: regenerated deploy/.env (bootstrap: no deploy secrets yet — see warnings above)" >&2
elif [ "$MODE" != "quiet" ]; then
  echo "gen-deploy-env: regenerated deploy/.env (mode 600) — emitted key names:"
  for k in $EMITTED; do echo "  $k"; done
fi
