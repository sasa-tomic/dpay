# shellcheck shell=bash
# Shared dfx deploy scaffolding for the dpay deploy scripts (dfx-deploy.sh, dfx-deploy-ic.sh,
# dfx-deploy-ic-staging.sh). Sourced, not executed. Depends on deploy/env-lib.sh (env_get) — source
# env-lib.sh FIRST. Each script remains a thin target-specific caller: it sets target vars (network,
# identity required-message, canister name, currency params) and calls these helpers.

# setup_dfx_env  — call AFTER cd-ing to the repo root. Sets ROOT + exports the offline toolchain
# paths (CARGO_HOME/RUSTUP_HOME under .dev/, dfx on PATH) so cargo/dfx resolve without a system install.
setup_dfx_env() {
  ROOT="$PWD"
  export CARGO_HOME="$ROOT/.dev/cargo" RUSTUP_HOME="$ROOT/.dev/rustup"
  export PATH="$ROOT/.dev/cargo/bin:$HOME/.local/share/dfx/bin:$PATH"
}

# require_cmd CMD MSG  — exit 1 with MSG on stderr if CMD is not on PATH.
require_cmd() {
  local cmd="$1" msg="$2"
  command -v "$cmd" >/dev/null 2>&1 || { echo "$msg" >&2; exit 1; }
}

# nat  — stdin: a dfx candid reply; stdout: the first nat value's digits, underscores stripped.
# e.g. `(7_500 : nat64)` -> `7500`.
nat() { grep -oE '[0-9][0-9_]*' | head -1 | tr -d '_'; }

# build_canister_wasm CRATE  — release-build the canister crate to wasm32-unknown-unknown.
build_canister_wasm() {
  local crate="$1"
  cargo build -p "$crate" --target wasm32-unknown-unknown --release
}

# refresh_candid CANISTER  — regenerate dfx/<CANISTER>.did from the built wasm. Caller MUST run
# `require_cmd candid-extractor ...` first: the `>` redirect truncates the .did before candid-extractor
# runs, so guarding here would be too late to prevent truncation when the tool is absent.
refresh_candid() {
  local canister="$1"
  mkdir -p dfx
  candid-extractor "target/wasm32-unknown-unknown/release/${canister}.wasm" > "dfx/${canister}.did"
}

# merge_canister_id CANISTER NETWORK ID  — merge ID into canister_ids.json under CANISTER.NETWORK
# (never clobbers sibling keys; the file is the durable map of ALL owned canisters).
merge_canister_id() {
  local canister="$1" network="$2" id="$3" tmp
  tmp="$(mktemp)"
  jq --arg c "$canister" --arg n "$network" --arg id "$id" '.[$c][$n] = $id' canister_ids.json > "$tmp" && mv "$tmp" canister_ids.json
}

# load_identity REQUIRED_MSG  — resolve DPAY_DFX_IDENTITY (env > deploy/.env). If empty, print
# REQUIRED_MSG (may be multiline) to stderr + exit 1. Defines the dfx_i() wrapper, then loads
# PRINCIPAL; on dfx failure surfaces dfx's actual stderr, then calls identity_load_hint if the caller
# defined one (it may reference $IDENT, which is set before the hook runs), then exits 1.
# Sets globals: IDENT, PRINCIPAL, dfx_i.
load_identity() {
  local required_msg="$1" _iderr
  IDENT="${DPAY_DFX_IDENTITY:-$(env_get DPAY_DFX_IDENTITY deploy/.env)}"
  [ -n "$IDENT" ] || { printf '%s\n' "$required_msg" >&2; exit 1; }
  dfx_i() { dfx --identity "$IDENT" "$@"; }
  _iderr="$(mktemp)"
  # shellcheck disable=SC2034 # PRINCIPAL is an intentional global read by the sourcing caller.
  if ! PRINCIPAL="$(dfx_i identity get-principal 2>"$_iderr")"; then
    echo "cannot load dfx identity '$IDENT' — dfx reported:" >&2
    sed 's/^/    /' "$_iderr" >&2
    rm -f "$_iderr"
    if declare -F identity_load_hint >/dev/null 2>&1; then identity_load_hint; fi
    exit 1
  fi
  rm -f "$_iderr"
}

# probe_catalog  — fetch the canister's currencies() catalog ONCE into $CATALOG (a dfx candid reply).
# Used by has_currency() for idempotent register_currency guards (register_currency rejects an existing
# id, so a re-run of a deploy script must skip already-registered ids). Caller MUST have set $CANISTER,
# $NETWORK, and dfx_i (via load_identity). Best-effort: a query failure leaves CATALOG empty so
# has_currency() reports "no" (a safe re-register attempt — register_currency itself rejects a dup).
probe_catalog() { CATALOG="$(dfx_i canister call "$CANISTER" currencies --network "$NETWORK" --query 2>/dev/null || true)"; }

# has_currency ID  — is currency ID present in $CATALOG? Caller MUST probe_catalog() first. Returns
# "no" on a missing/empty catalog (safe: register_currency rejects a duplicate idempotently).
has_currency() { echo "$CATALOG" | grep -qE "currency = $1 : nat32" && echo yes || echo no; }

# _register ARG [expect_mismatch]  — call register_currency(ARG); expect Ok on a real network (the
# target ledger validates decimals/fee/wrapper_name). On local rehearsal against the mock DUSD ledger,
# a real-ledger call is EXPECTED to reject — the facade's cross-canister validation formats the error
# as "icrc1_decimals rejected: …" / "metadata mismatch: …", so pass "expect_mismatch" to treat that
# validation reject as success (it still proves the candid ARG is well-formed). Any other outcome is an
# error (exit 1). Depends on $CANISTER, $NETWORK, dfx_i (all set by the caller before use).
_register() { # $1=arg  $2=expect_mismatch (optional, local rehearsal only)
  local arg="$1" expect="${2:-}"
  local out
  set +e
  out="$(dfx_i canister call "$CANISTER" register_currency "$arg" --network "$NETWORK" 2>&1)"
  set -e
  if echo "$out" | grep -q 'Ok'; then
    echo "   → Ok"
  elif [ "$expect" = expect_mismatch ] && echo "$out" | grep -qiE 'metadata mismatch'; then
    echo "   → expected validation mismatch (local rehearsal: mock ledger ≠ target metadata) — call shape OK"
  elif [ "$expect" = expect_mismatch ] && echo "$out" | grep -qiE 'icrc1_(decimals|fee|symbol)|wrapper_name'; then
    echo "   → expected validation mismatch (local rehearsal) — call shape OK"
  else
    echo "   → UNEXPECTED register_currency outcome:" >&2
    # shellcheck disable=SC2001 # sed prefixes EVERY line; ${var//} can't do per-line substitution.
    sed 's/^/     /' <<<"$out" >&2
    exit 1
  fi
}
