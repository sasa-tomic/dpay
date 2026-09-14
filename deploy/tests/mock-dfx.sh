#!/usr/bin/env bash
# shellcheck shell=bash
#
# Mock `dfx` for deploy/tests/literal-parity.sh — answers EVERY subcommand the two deploy scripts
# (scripts/dfx-deploy.sh, scripts/dfx-deploy-ic-staging.sh in local rehearsal) use, offline +
# deterministically, and CAPTURES the Candid install arguments byte-for-byte:
#   * `canister id <name>`     -> fixed pseudo-principals (these end up embedded in the literals)
#   * `identity get-principal` -> a fixed pseudo-principal
#   * `canister info`          -> empty (no Module hash => the staging flow picks --mode install)
#   * `canister call`          -> `(0 : nat)` (a script asserting on ledger balances aborts AFTER
#                                 the installs — the harness tolerates exactly that abort)
#   * everything else          -> exit 0
# Every `canister install` / `deploy` carrying `--argument` appends one line
#     <op> <canister>[ mode=<mode>] <base64-of-argument>
# to $DPAY_DFX_MOCK_ARGS (base64 keeps the literal's embedded newlines diff-safe) and the flattened
# argv to $DPAY_DFX_MOCK_TRACE (debug only). The parity artifact is $DPAY_DFX_MOCK_ARGS.
set -uo pipefail
: "${DPAY_DFX_MOCK_ARGS:?mock-dfx requires DPAY_DFX_MOCK_ARGS}" "${DPAY_DFX_MOCK_TRACE:?mock-dfx requires DPAY_DFX_MOCK_TRACE}"

[ $# -gt 0 ] || exit 0
printf 'dfx %s\n' "${*//$'\n'/\\n}" >>"$DPAY_DFX_MOCK_TRACE"

argv=("$@")
# Strip leading global flags (the `--identity NAME` pair from dfx-lib.sh's dfx_i wrapper).
i=0
while [ $i -lt ${#argv[@]} ] && [ "${argv[$i]}" = "--identity" ]; do i=$((i + 2)); done
group="${argv[$i]:-}"

# `deploy <canister>`: the canister is the FIRST token after the group (no subcommand); every other
# group (canister, identity, …) has a subcommand first. Positionals start after both.
case "$group" in
  deploy) pos=$((i + 1)) ;;
  *) pos=$((i + 2)) ;;
esac
sub="${argv[$((i + 1))]:-}"

# Scan the remaining tokens: --argument/--mode consume the next token, other flags stand alone, and
# the FIRST bare word is the canister name (flag values like `local`/`install`/wasm paths never
# come first, so they cannot be mistaken for it).
name="" mode="" arg="" expect=""
j="$pos"
while [ "$j" -lt ${#argv[@]} ]; do
  t="${argv[$j]}"
  if [ -n "$expect" ]; then
    [ "$expect" = argument ] && arg="$t"
    [ "$expect" = mode ] && mode="$t"
    expect=""
  else
    case "$t" in
      --argument | --mode) expect="${t#--}" ;;
      -*) ;;
      *) if [ -z "$name" ]; then name="$t"; fi ;;
    esac
  fi
  j=$((j + 1))
done

case "$group" in
  identity) echo "dfxmock-identity-principal"; exit 0 ;;
  ping | start | stop | build) exit 0 ;;
esac

if [ "$group/$sub" = "canister/install" ] || [ "$group" = "deploy" ]; then
  [ -n "$arg" ] || { echo "mock-dfx: ${*//$'\n'/\\n} carries no --argument (the mock only models the literal-parity flows)" >&2; exit 1; }
  if [ "$group" = "deploy" ]; then label="deploy"; else label="canister/install"; fi
  printf '%s %s%s %s\n' \
    "$label" "$name" "${mode:+ mode=$mode}" \
    "$(printf '%s' "$arg" | base64 -w0)" >>"$DPAY_DFX_MOCK_ARGS"
  exit 0
fi

case "$group/$sub" in
  canister/id)
    case "$name" in
      dpay_canister) echo "dfxmock-facade-local" ;;
      dpay_canister_staging) echo "dfxmock-facade-staging" ;;
      icrc_ledger) echo "dfxmock-ledger-local" ;;
      *) echo "dfxmock-$name" ;;
    esac
    ;;
  canister/call) echo "(0 : nat)" ;;
esac
exit 0
