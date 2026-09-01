# OpenCryptoPay — measured findings

Everything here was measured against the LIVE provider on 2026-09-01, not read from documentation.
That distinction matters: the public spec (`https://github.com/openCryptoPay/landingPage` README) is
**stale in at least two ways that would break an implementation**, both recorded below. Where this
file and the README disagree, this file wins — and re-measure before trusting either.

This is the reference doc. The implementation plan is
[`2026-09-01-opencryptopay-implementation.md`](2026-09-01-opencryptopay-implementation.md).

## What OpenCryptoPay is

A permissionless, license-free standard for paying a merchant with crypto. The merchant's till shows
a **static** QR; the payer's wallet resolves it to a live quote, pays the named asset on the named
chain, and reports the transaction back. DFX.swiss authored it and runs the only production
provider, but anyone may host one under their own domain.

**It is an ONLINE-payer standard.** The payer's wallet makes three HTTP calls (fetch quote, fetch
transaction details, report proof) and the quote is a live 300-second FX quote. This does not and
cannot extend dpay's offline-payer feature. It is distribution — real merchants — not a new rail.

## The flow

1. **QR** → `https://app.dfx.swiss/pl/?lightning=<LNURL-bech32>`. The `lightning` parameter is a
   bech32 (LUD-01) encoding of an API URL. Decoding it yields e.g.
   `https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e`. Equivalently, replace `app` with `api` in
   the QR URL — the provider accepts the whole query string as-is.
2. **Payment details** — `GET {api}?timeout=0`. Returns the merchant identity, a `quote{id,
   expiration}`, and `transferAmounts[]`: one entry per method, each with the exact asset amounts.
   `timeout` (seconds) is a long-poll for a pending charge; `0` returns instantly. No pending charge
   → HTTP 404 with a body that still carries the merchant identity.
3. **Transaction details** — `GET {callback}?quote={id}&method={method}&asset={asset}` returns the
   destination `uri` for that choice. Steps 2+3 collapse into one call by adding `method` + `asset`
   to the step-2 URL.
4. **Pay + report** — move the funds on-chain yourself, then `GET {callback with /cb → /tx}` with
   the proof.

## Assets actually accepted (live, 2026-09-01)

| Method | Live assets | dpay ships |
|---|---|---|
| `InternetComputer` | ckBTC, **VCHF**, ICP, VEUR | ckBTC (1), VCHF (7), ICP (8) |
| `Solana` | SOL, USDC, USDT | SOL, USDC |
| — | *(README also claims ckETH, ckUSDC, ckUSDT — the live API does NOT offer them)* | ckUSDC (2), ckETH (6) |

Identity checks, not name matches:

- OCP's VCHF ledger `ly36x-wiaaa-aaaai-aqj7q-cai` == `vchf_ledger` in `dfx/catalog_truth.json`.
- OCP's ckBTC ledger `mxzaz-hqaaa-aaaar-qaada-cai` == `ckbtc_ledger`.
- DFX's `Solana/USDC` mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` == `USDC_MINT_ADDRESS`
  in `app/solana/spl.ts`.

**ckUSDC — dpay's stated launch rail — is not accepted.** Raise it with DFX; do not design around it.

## Stale-README trap #1: the IC URI shape

README says `icp:<canister>?amount=<n>`. The live API returns:

    icp:ly36x-wiaaa-aaaai-aqj7q-cai/transfer?to=ygf2v-…-4ae&amount=1.

i.e. `icp:<LEDGER>/transfer?to=<DESTINATION PRINCIPAL>&amount=<DECIMAL>`. Note `amount=1.` — a
**trailing bare decimal point**, which naive decimal parsers reject. Parse defensively and reject
loudly rather than coercing.

Solana returns a standard `solana:<address>?amount=<decimal>`.

## Stale-README trap #2: Solana omits the token

For `Solana/USDC` the live URI is `solana:2eQ2Somiat…?amount=1.246922` — with **no `spl-token`
parameter**, so it is indistinguishable from a native SOL transfer of that amount. A wallet that
trusts the URI alone sends the wrong asset. The selected `asset` from step 3 is the only
authority. Also unresolved: whether the address is the owner or the associated token account. **Do
not implement the Solana leg until DFX answers this.**

## Submission: two options, and which to use

    GET /v1/lnurlp/tx/{paymentId}?quote={id}&method={method}&asset={asset}&…proof

- **Option A (their `hint` recommends it):** `icrc2_approve` the provider, then report
  `sender=<principal>`; they pull with `icrc2_transfer_from`.
- **Option B:** transfer directly with `icrc1_transfer`, then report `tx=<block index>`.

**Use Option B. Never Option A.** Option A grants DFX a spending allowance against the user's ledger
account — custody-adjacent, and gratuitous when B exists. Verified that B is really implemented: a
fabricated index returns

    400 "Transaction 999999999999 not confirmed in blockchain InternetComputer"

so the handler exists, consumes our identifier, and **verifies against the ledger** rather than
crediting on assertion.

## The loss path — the most important finding

The payer sends irreversible funds **before** submitting proof, and gets **exactly one submission
attempt**. Measured:

- A failed submission **burns the quote**: a second attempt with the same quote returns
  `404 "No actual quote with ID … found"`.
- A failed submission **also burns the tx id**: reusing it under a fresh quote returns
  `400 "Transaction … already assigned to another quote"`. The binding is recorded even though the
  first attempt *failed*.

So a timeout on that single HTTP GET leaves the transfer on-chain, unattributable, with nothing
bought — worse than a declined payment, because it costs the same and teaches less. ICRC-1 has no
chargeback.

**Design consequences, binding:**

- Fetch the quote as late as possible; sign and submit on-chain only after the user approves.
- Confirm the transfer on-chain and obtain a real block index BEFORE calling `/tx`.
- Call `/tx` exactly once, with a generous timeout and **no blind retry**.
- If `/tx` does not return a definitive success, the honest state is **unknown/pending**, never
  "failed" and never "paid". Record the block index so the user can claim it with the merchant.
  This is the same outcome-honesty discipline as `RailOutcome`'s `unknown` in `app/services/rail.ts`.

## Trust model — read before writing the parser

Verified: the example QR's `lightning` parameter bech32-decodes (hrp `lnurl`) to exactly
`https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e`.

**A scanned LNURL can name ANY host.** Nothing in the standard binds it to a known provider, so a
hostile sticker over a real till's QR points the wallet at an attacker's server, which then supplies
the merchant name, the amount, and the destination address. This is inherent to the standard — every
OCP wallet has it — and it is the same threat dpay's payment links already answer. Answer it the
same way (`app/lib/deepLink.ts` module header is the authority):

- Never auto-sign. The user approves an explicit review, always.
- Show the **full** destination account, never truncated to the point of being unverifiable.
- Treat every provider-supplied string — merchant name, note, label — as **claimed**, not verified.
- Show the provider host the quote came from, so "why does this say api.evil.example" is answerable.
- Require `https`. Refuse `http` and any other scheme loudly.
- Validate the destination through the core (`icp_validate_principal` /
  `icp_validate_icrc_account`) before the payer sees it, so a malformed address is refused by the
  same validator the rest of the app uses.
- **Verify the bech32 checksum.** It does not stop a crafted hostile LNURL, but it does stop a
  damaged one from silently resolving to a different host.

## Quote lifetime

300 seconds exactly, measured across repeated fetches. Every `GET` of the payment details mints a
**new** quote id; the previous one stays valid until used or expired. Matches dpay's existing ~5min
request expiry, so no new timing model is needed.

## Receiving (dpay as merchant) — assessed, not recommended now

A full merchant API exists (`/v1/paymentLink*`), but `POST /v1/paymentLink` requires `bearer` auth
**and** a `routeId` — a sell route, i.e. a bank IBAN. DFX settles merchant proceeds as **fiat to a
bank**. So accepting via DFX means merchant onboarding plus KYC, and a self-payment round trip costs
1.99% sell plus fees and takes days. Not a test loop.

dpay could instead **host its own OCP provider endpoint** (the standard permits it), but that tests
dpay against dpay, which `e2e/` already does. It proves nothing about third-party acceptance.

## Provider risk

- `github.com/DFXswiss/api` now 404s — the reference implementation went private. "Everything is
  open source" is stale.
- The swagger (`https://api.dfx.swiss/swagger-json`, 194 paths) declares **no query parameters** for
  `/v1/lnurlp/tx/{id}`, so there is no machine-readable contract for the submission call. The README
  is the only documentation and it is wrong twice.
- The standard is open; in practice DFX is the only provider. Treat provider identity as
  configuration, not a constant.

## What has NOT been proven

No payment has been made. Everything above is read-only probing. Specifically unverified: that a
**real** confirmed ICP transfer plus its block index is accepted end to end. That costs CHF 1
(the public test till `pl_beeddb41cd4b6d9e` is fixed-amount, `min == max`, no smaller test exists)
and is irreversible. Rules for spending the agent float: `CLAUDE.md` → `docs/AGENT-FUNDS.md`.
