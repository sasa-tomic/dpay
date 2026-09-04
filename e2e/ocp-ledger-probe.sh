#!/usr/bin/env bash
# Free probe: does `<ledgerCanisterId>:<blockIndex>` make the OpenCryptoPay provider verify against
# THAT ledger, instead of the native ICP ledger it was measured reading on 2026-09-03?
#
# Costs nothing — every reported index is fabricated, so no funds move. Each probe mints its OWN
# quote (a GET of the payment details mints one) because a failed submission burns the quote, and
# each uses a DISTINCT index because a failed submission also binds the id it was given.
#
# The experiment is a discrimination, not a demonstration: the indexes are chosen so the two
# hypotheses ("the prefix selects the ledger" vs "everything resolves against ICP") predict
# DIFFERENT answers. Read the table this prints against `docs/specs/2026-09-01-opencryptopay-findings.md`.
set -euo pipefail

LINK=${LINK:-pl_beeddb41cd4b6d9e}
API=${API:-https://api.dfx.swiss/v1/lnurlp}

probe() {
  local label=$1 asset=$2 tx=$3
  local quote
  quote=$(curl -sf "${API}/${LINK}?timeout=0" | jq -r '.quote.id')
  [ -n "$quote" ] && [ "$quote" != "null" ] || { echo "FAIL: no quote for ${label}"; return 1; }
  # `:` percent-encoded, because that is what `URLSearchParams` sends from the app.
  local encoded=${tx//:/%3A}
  local body
  body=$(curl -s "${API}/tx/${LINK}?quote=${quote}&method=InternetComputer&asset=${asset}&tx=${encoded}")
  printf '%-46s %-6s %-52s %s\n' "$label" "$asset" "$tx" "$(echo "$body" | jq -rc '.message // .')"
}

printf '%-46s %-6s %-52s %s\n' LABEL ASSET REPORTED_TX PROVIDER_SAID
probe "VCHF prefix, index NOT on VCHF but on ICP"  VCHF  "ly36x-wiaaa-aaaai-aqj7q-cai:12345678"
probe "bare index (control, old shape)"            VCHF  "12345679"
probe "VCHF prefix, index that EXISTS on VCHF"     VCHF  "ly36x-wiaaa-aaaai-aqj7q-cai:80017"
probe "VCHF prefix, one past the VCHF tip"         VCHF  "ly36x-wiaaa-aaaai-aqj7q-cai:81023"
probe "ckBTC prefix, index NOT on ckBTC but on ICP" ckBTC "mxzaz-hqaaa-aaaar-qaada-cai:9999998"
