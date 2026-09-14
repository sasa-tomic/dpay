# shellcheck shell=bash
# Shared dfx deploy scaffolding for the dpay deploy scripts (dfx-deploy.sh, dfx-deploy-ic.sh,
# dfx-deploy-ic-staging.sh). Sourced, not executed. Depends on deploy/env-lib.sh (env_get) — source
# env-lib.sh FIRST. Each script remains a thin target-specific caller: it sets target vars (network,
# identity required-message, canister name) and calls these helpers.

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

# icrc_ledger_init_arg OWNER FEE DECIMALS SYMBOL NAME [BASE_INDENT]  — the Candid
# `variant { Init = record { … } }` argument BOTH inline-ledger deploys install the REAL
# ic-icrc1-ledger with: scripts/dfx-deploy.sh (local replica, owner = the facade) and
# scripts/dfx-deploy-ic-staging.sh (staging DUSD ledger, owner = the staging facade). ONE literal,
# so a field added or retuned here reaches demo + staging together and can never fork their init
# args. Parameterized exactly where the callers differ (owner/controller principal, fee, decimals,
# symbol, token name); the fixed shape is policy: empty metadata/initial_balances, icrc2 on,
# icrc152 off, cost-tuned archive_options (trigger_threshold 10M => archives never spawn in a
# demo/pilot). BASE_INDENT (default: none) is the continuation-line indent baked into the OUTPUT
# string — it exists only so each caller's emitted bytes stay identical to its pre-builder literal
# (byte-parity pinned against deploy/tests/fixtures/ by `just dfx-arg-parity`); Candid ignores
# whitespace, but the parity fixtures do not.
icrc_ledger_init_arg() {
  local owner="$1" fee="$2" dec="$3" sym="$4" name="$5" ind="${6:-}"
  printf '(variant { Init = record {\n'
  printf '%s  minting_account = record { owner = principal "%s" };\n' "$ind" "$owner"
  printf '%s  transfer_fee = %s : nat;\n' "$ind" "$fee"
  printf '%s  decimals = opt (%s : nat8);\n' "$ind" "$dec"
  printf '%s  token_symbol = "%s";\n' "$ind" "$sym"
  printf '%s  token_name = "%s";\n' "$ind" "$name"
  printf '%s  metadata = vec {};\n' "$ind"
  printf '%s  initial_balances = vec {};\n' "$ind"
  printf '%s  feature_flags = opt record { icrc2 = true; icrc152 = false };\n' "$ind"
  printf '%s  archive_options = record {\n' "$ind"
  printf '%s    num_blocks_to_archive = 10_000 : nat64;\n' "$ind"
  printf '%s    trigger_threshold = 10_000_000 : nat64;\n' "$ind"
  printf '%s    controller_id = principal "%s";\n' "$ind" "$owner"
  printf '%s  };\n' "$ind"
  printf '%s  index_principal = null;\n' "$ind"
  printf '%s} })' "$ind"
}

# facade_init_arg DEMO_LEDGER PER_TX_CAP  — the facade canister's Candid init argument
# `record { demo_ledger; per_tx_cap; controller }` as BOTH inline-arg deploys install it:
# scripts/dfx-deploy.sh (this replica's DUSD ledger; cap from dpay-fixture's expect.env) and
# scripts/dfx-deploy-ic-staging.sh (the staging DUSD ledger; fixed 100_000). PER_TX_CAP passes
# through VERBATIM (nat64 literal text — `100000` and `100_000` both stay as written).
# controller=null = open-demo mode, locked by set_controller immediately after install.
# (scripts/dfx-deploy-ic.sh — mainnet — deliberately does NOT use this builder: its init arg comes
# from the tracked dfx/args/init.arg via dpay-fixture + the demo_ledger-vs-canister_ids.json gate.)
facade_init_arg() {
  printf '(record { demo_ledger = principal "%s"; per_tx_cap = %s : nat64; controller = null })' "$1" "$2"
}
