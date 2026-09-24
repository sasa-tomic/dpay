# OpenCryptoPay — measured findings

Everything here was measured against the LIVE provider on 2026-09-01, not read from documentation.
That distinction matters: the public spec (`https://github.com/openCryptoPay/landingPage` README) is
**stale in at least two ways that would break an implementation**, both recorded below. Where this
file and the README disagree, this file wins — and re-measure before trusting either.

This is the reference doc. The implementation plan is
[`2026-09-01-opencryptopay-implementation.md`](2026-09-01-opencryptopay-implementation.md).

## What OpenCryptoPay is

A permissionless, license-free standard for paying a merchant with crypto. The merchant's checkout shows
a **static** QR; the payer's wallet resolves it to a live quote, pays the named asset on the named
chain, and reports the transaction back. DFX.swiss authored it and runs the only production
provider, but anyone may host one under their own domain.

**It is an ONLINE-payer standard.** The payer's wallet makes three HTTP calls (fetch quote, fetch
transaction details, report proof) and the quote is a live 300-second FX quote. This does not and
cannot extend dpay's offline-payer feature. Its value would be distribution — reaching real
merchants — not a new rail; how much of that has actually been proven is "What has NOT been proven"
at the end of this file.

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

**Harness note (2026-09-05, neither an app bug):** the QR's LNURL decodes to the step-2 quote-mint
endpoint (`https://api.dfx.swiss/v1/lnurlp/<id>`), never to the step-3 `/cb/` callback. An
agent-reconstructed LNURL that instead encoded the `/cb/` URL made the app reach DFX and surface the
provider's honest `404 "No matching actual quote found"` verbatim — correct behaviour, provider copy
shown as-is — and a bad-checksum LNURL was refused pre-network as damaged. Both refusals are the
trust model below doing its job.

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

## The standard's reach — which wallets pay which method (measured 2026-09-03, re-measured 2026-09-04)

`GET https://api.dfx.swiss/v1/paymentLink/walletApp` is the provider's own compatibility list — the
wallets a payer is offered when they scan one of these codes. Both reads return the same shape:
**29 wallets, and not one of them declares `InternetComputer`.** The complete method set across all
29 is `Arbitrum, Base, BinancePay, BinanceSmartChain, Bitcoin, Cardano, Citrea, CitreaTestnet,
Ethereum, Gnosis, Haqq, KucoinPay, Lightning, Monero, Optimism, Polygon, Sepolia, Solana, Tron,
Zano`.

Reach, in wallets per method: Lightning 21, Ethereum 8, Arbitrum 6, Polygon 6, BinanceSmartChain 5,
Optimism 5, Base 5, Bitcoin 5, Solana **1** (Unstoppable Wallet). The four wallets `opencryptopay.io`
puts in its hero row (read 2026-09-04) are narrower than the branding suggests: Cake Wallet is EVM +
Bitcoin + Monero, Phoenix and Wallet of Satoshi are Lightning only, Binance is BinancePay only.

- **Measured:** no wallet in the provider's own list can pay any Internet Computer asset — not VCHF,
  not ckBTC, not native ICP.
- **Inferred, weaker:** some wallet outside that list could implement the flow, but none is known,
  and this list is what the payer is actually offered. Treat "a third-party wallet pays an
  IC-settled checkout" as false until a specific wallet is measured doing it.
- It is plausibly why the `tx` spelling below is documented nowhere: the `InternetComputer` leg has
  no third-party wallet to have needed it written down.

### Oisy — the one wallet whose source shows an IC leg (re-measured 2026-09-05)

- **MEASURED (2026-09-05):** the DFX list above is unchanged — same 29 wallets, same method union, no
  `InternetComputer`, no Oisy entry (`GET https://api.dfx.swiss/v1/paymentLink/walletApp`); the live
  DFX shop `/pl` page's recommended/compatible/semi-compatible rows likewise name no Oisy.
- **SOURCE-ONLY** (`github.com/dfinity/oisy-wallet`, `main`, pushed 2026-09-04): Oisy ships an IC
  OpenCryptoPay payer — `src/frontend/src/icp/services/ic-open-crypto-pay.services.ts` (commit
  `455f16ac49ec`, 2026-03-05), network flag `pay: {openCryptoPay: 'InternetComputer'}` at
  `src/frontend/src/env/networks/networks.icp.env.ts:46`. Assets are symbol-matched
  (`mapTokenToPayableToken`): ICP plus any ICRC token in Oisy's list — including VCHF on the SAME
  ledger `ly36x-wiaaa-aaaai-aqj7q-cai` this file already identity-checked.
- **It is an Option-A wallet.** `payIcp` does `icrc2_approve(spender, amount+fee, 5-minute expiry)`
  then `GET /tx?quote=&method=&asset=&sender=<principal>` (`getIcPaymentUri`) — it never reports a
  tx id, so the CHF-1 spelling class cannot occur in its flow.
- **The `&ref=` hazard is real at source and is answered by who writes the memo.** `decodeQrCodeUrn`
  keeps unknown params (`DecodedUrnSchema` uses `.catchall()`), but `validateIcTransfer` reads only
  `to`/`amount` and the approve sets no memo — `ref` is accepted and dropped. It does not need to
  survive: against a dpay checkout the memo is written by the party that COLLECTS, and that is the
  shop's own phone, which has the reference from its own checkout-open (see the 2026-09-12 section below).
  Money-moves-but-uncredited would need a collector using somebody else's memo; ours cannot.
- **Ingestion + drive boundary:** the only entry is the in-app scanner (`ScannerCode.svelte`);
  `parseOpenCryptoPayCode` requires a URL with a `?lightning=` param, so a bare `LNURL1…` string is
  refused as an invalid code, and `AppPath` defines no OCP deep-link route. Live (2026-09-05):
  oisy.com IS the wallet (`app.oisy.com` is NXDOMAIN) and the scanner sits behind Internet Identity
  sign-in (WebAuthn + CAPTCHA) — the flow was not driven past that gate. Everything above the gate
  is measured; everything below it stays source-only.

#### The wallet is a WEB page, and that broke the scan outright (measured + fixed 2026-09-12)

The founder scanned a live dpay checkout code with Oisy and got `Code/URL ist nicht gültig` — the
scanner's one catch-all (`ScannerCode.svelte`, `scanner.error.code_link_is_not_valid`), which fires
when anything in the read throws. The code itself was never the problem: it decodes (independently,
through the same `bech32` algorithm Oisy uses) to this relay's own `/v1/lnurlp/{id}`, and that route
answers a correct `payRequest`. What threw was the fetch. Oisy runs in a browser and sends
`Content-Type: application/json` on the GET, so the read is preflighted — and prod answered `OPTIONS`
with `405` and carried no `Access-Control-Allow-Origin` on the GET either, so Chrome refused the
request before a handler ran. The reference provider answers `access-control-allow-origin: *` on the
same three paths; dpay now does too, on those three and nothing else
(`provider_cors_middleware`, `crates/dpay-relay/src/app.rs`). Reproduced and re-driven in real
Chrome, cross-origin, with web security ON: `Failed to fetch` against prod, `HTTP 200` against the
fixed build, and `/api/v1/*` still refused in both.

**And it makes the next question unavoidable, which is why that landed in the same session.** Oisy
reports its approve with `GET /tx?…&sender=<principal>` and treats ANY 2xx as a completed payment
(`payIcp` → `PAYMENT_CONFIRMED`). A checkout that could be READ but not paid would therefore have told
an Oisy user they had paid while their allowance expired unspent — strictly worse than the
invalid-code refusal it replaced. So the checkout does not refuse an allowance report; it collects the
allowance. See the verdict below.

**Verdict on "no third-party wallet can settle an IC asset": the reason it held has been removed
(2026-09-12, founder-directed).** It stands for every wallet DFX offers (re-measured), and Oisy is
still the one counter-candidate. What changed is that dpay's checkout now COLLECTS an allowance instead
of refusing one. The merchant's own phone does it — never the relay, which still holds no key —
because the spender Oisy approves is the merchant's own principal (`validateIcUriTransfer` reads
`to` from our URI), and that phone already holds the key and is already polling the charge.

**The shape, and why it is the only one that fits the non-negotiables.** The relay is a courier: a
`sender` report becomes an untrusted `PullClaim` on the charge and is handed to the merchant on the
poll they already make. The phone signs a real `icrc2_transfer_from` carrying the charge's `ref` as
the memo — without which money would move and the sale would stay open — and the RELAY's own ledger
read is still the only thing that turns the sale green. No dpay-controlled address is involved at
any step. Nothing is checked before signing, deliberately: reading `icrc2_allowance` first costs a
round trip, cannot close the race, and tells us nothing the ledger's own `InsufficientAllowance`
does not already carry. The pieces, each owning its own half: `PullClaim` and `claim_pull`
(`crates/dpay-relay/src/checkout.rs`), `preparePull` (`app/services/rail.ts`), `collect`
(`app/components/CheckoutCharge.tsx`), `transfer_from_arg` (`crates/dpay-icp/src/icrc.rs`).

**Proven offline end to end, and still undriven against Oisy itself.** e2e flow 177 drives the
whole path on the fake-IC gateway — a real signed `icrc2_approve` from a stand-in allowance wallet,
the standard's own step-4 report, the app's own `icrc2_transfer_from`, the relay observing it, and
the customer's account down by exactly the price. What remains unproven is everything on Oisy's
side of the wire: its scanner reaching the fetch, and VCHF being enabled for a given user (it sits
in Oisy's *additional* ICRC set, `tokens.icrc.json`, not its chain-fusion defaults, so a user who
has not added it would be shown a priced charge with nothing to pay it in). Driving Oisy needs an
account past its Internet Identity gate and a franc or two — a founder operation, not an agent one.

**The residual hazard, written down rather than hidden.** A claim is unauthenticated: anyone holding
a charge id can name any principal. A forged one moves nothing (a pull can only spend what that
account deliberately approved this shop for, at this charge's exact amount). The narrow real case is
a customer who approved this shop, walked away, and left an allowance inside the wallet's five-minute
window that a claim could aim at the shop's next same-priced charge. One live charge per merchant
and that window are the bounds. `PullClaim`'s own doc carries this; it is repeated here only because
this file is what an outsider reads.
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
trusts the URI alone sends the wrong asset. The selected `asset` from step 3 is the only authority.

**Owner-vs-ATA: answered by measurement 2026-09-02, without needing DFX.** Two independent reads
agree that the address is the **owner wallet**, not a token account:

- Within one quote, `Solana/SOL`, `Solana/USDC` and `Solana/USDT` all return the **same** address
  (`2eQ2Somiat63oqSPwzQLrrNiceC8F6TH85dt2qDe3z36`). An associated token account is derived per mint,
  so three assets sharing one address cannot be ATAs.
- `getAccountInfo` on mainnet reports `owner: 11111111111111111111111111111111` (System Program),
  `space: 0`, no data — a plain wallet. A token account is owned by the SPL Token program and
  carries 165 bytes.

So a token leg must pay the **ATA derived from that owner and the token's mint**, which is what the
app already computes for its own USDC sends (`app/solana/spl.ts`). The blocker on implementing the
Solana token leg is therefore removed; native `Solana/SOL` was never affected.

## Submission: two options, and which to use

    GET /v1/lnurlp/tx/{paymentId}?quote={id}&method={method}&asset={asset}&…proof

- **Option A (their `hint` recommends it, and DFX's engineering team calls it preferred):**
  `icrc2_approve` the provider, then report `sender=<principal>` and no `tx`; they pull with
  `icrc2_transfer_from`.
- **Option B:** transfer directly with `icrc1_transfer`, then report the transaction id. The id's
  spelling is the next section, and getting it wrong is what cost a real payment.

**Use Option B. Never Option A.** Option A grants DFX a standing spending allowance against the
user's ledger account — control over funds dpay must never arrange (`CLAUDE.md`'s non-custodial
non-negotiable), and it survives a failed submission, so a payment that goes wrong leaves the
allowance behind. It also costs two ledger fees instead of one. B's handler exists, consumes our
identifier, and **verifies against the ledger** rather than crediting on assertion: a fabricated
index returns

    400 "Transaction 999999999999 not confirmed in blockchain InternetComputer"

## Step-2 body: the field names, verified

Confirmed present in a live response (2026-09-01) — these are measured, not inferred from the spec:

    callback                       string, https
    quote.id                       string
    quote.expiration               ISO-8601 with Z, e.g. "2026-09-01T14:50:04.660Z"
    requestedAmount {asset, amount}   asset is a FIAT code (e.g. "CHF"); amount is a JSON NUMBER
    displayName                    string — claimed merchant name, unverified
    transferAmounts[].method       string
    transferAmounts[].available    boolean
    transferAmounts[].assets[].asset    string
    transferAmounts[].assets[].amount   JSON STRING, e.g. "0.000016", "1."

Full top level: `callback, displayName, displayQr, externalId, id, maxSendable, metadata,
minSendable, mode, possibleStandards, quote, recipient, requestedAmount, route, standard, tag,
transferAmounts`.

Note the asymmetry: per-asset `amount` values are **strings**, but `requestedAmount.amount` is a
**number**. Any parser must handle both, and must never let a JSON number reach a decimal parser via
`String()` — a small value can serialise as `1.6e-7`, a spelling every decimal grammar here rejects.

**A method it cannot currently settle carries an EMPTY `assets` array.** Measured on every response
(2026-09-02): `TaprootAsset`, `Spark` and `Arkade` all arrive as `{available: false, assets: []}`.
This is normal traffic, not a malformed body, and a parser that refuses over it refuses every real
checkout — which is exactly what happened (review ledger row 16).

## Step-2 and step-3 amounts agree within one quote

Measured 2026-09-01 by fetching both reads against the **same** quote id:

    InternetComputer/VCHF   step2=1.           step3=1.           same
    InternetComputer/ICP    step2=0.50795551   step3=0.50795551   same
    Solana/SOL              step2=0.01219252   step3=0.01219252   same

So the provider does **not** re-price between the menu and the destination URI inside a quote, and a
wallet may treat a disagreement as a hard refusal rather than as normal drift. Comparing amounts
across *different* quotes will of course differ — the price moves — which is a trap when building
fixtures: two responses captured seconds apart are two quotes, not one.

## Response envelopes

Measured, not assumed — and **not** what an LNURL implementer would expect.

- **Errors use NestJS's `{statusCode, message, error}`**, uniformly across every failing status this
  integration meets: 404 `Payment link not found`, 404 `No actual quote with ID … found`, 400
  `Invalid method or asset`, 400 `Transaction … already assigned to another quote`. It is **not** the
  LNURL `{status:"ERROR", reason}` shape.
- **Two different 404s mean different things and must be told apart.** A 404 whose body is the
  payment-link payload (carries `tag:"payRequest"` / `displayName`) means *no charge is pending* —
  tell the user to ask the cashier to open a fresh charge. A 404 carrying the error envelope means the link
  is unknown — a stale or hostile QR. Collapsing them tells the second user to go talk to a cashier
  who does not exist.
- **Step 3 returns `{expiryDate, blockchain, uri, hint}`** at HTTP 200, and `blockchain` echoes the
  requested `method` exactly (verified for both `InternetComputer` and `Solana`). Since the URI names
  no asset, that echo is the only integrity signal the response carries — check it and refuse loudly
  on a mismatch.
- **The `/tx` URL has two accepted forms.** The provider's own `hint` advertises
  `/v1/lnurlp/tx/<paymentId>`; deriving it from the callback URL by `/cb/` → `/tx/` (the link id)
  also works. Both were confirmed live. Pick one and refuse loudly if the expected segment is
  missing rather than silently constructing a wrong URL.

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

## The reported `tx` selects the ledger — the `asset` parameter does not

**The most expensive finding here: getting this wrong cost a real payment.** It is a WIRE FORMAT,
not a provider defect, and dpay had it wrong for one payment.

### What it cost

A real CHF 1 payment was made in **VCHF** on 2026-09-03. dpay did everything correctly except the
identifier — VCHF ledger block **81001**, exactly `1.00000000` VCHF, to exactly the principal the
provider's own URI named (`ygf2v-…-4ae`, verified by decoding the block) — and reported it as a bare
`81001`. Two seconds later:

    Failed to handle hex payment pl_beeddb41cd4b6d9e:
    Transaction 81001 does not pay any matching activation

The money left and the sale was not credited. DFX say the VCHF did reach their payment address and
they are looking at recovering it; **treat that as unresolved until it lands.**

### The rule

Stated by DFX's engineering team on 2026-09-04 and **re-measured here before it was implemented**.
Three accepted `tx` spellings, and the SHAPE of the string is what picks the ledger:

| `tx` form | resolved against |
|---|---|
| 64-hex Rosetta hash | the native ICP ledger |
| bare block index | the native ICP ledger |
| `<ledgerCanisterId>:<blockIndex>` | that ICRC ledger |

So a bare index for a VCHF payment was always going to be looked up on the ICP ledger. The `asset`
parameter is validated (an asset the provider does not offer answers `400 "Invalid method or
asset"` — measured with ckUSDC) and then plays no part in choosing the ledger.

### The measurement (`just ocp-ledger-probe`, free — every index fabricated, no funds move)

Each probe mints its own quote and reports a distinct index, since a failed submission burns both.
Indexes chosen so the two hypotheses — "the prefix selects the ledger" vs "everything resolves
against ICP" — predict DIFFERENT answers. Tips read live off each ledger's `icrc3_get_blocks`
(`log_length`): VCHF 81 023, ckBTC 4 596 115.

| reported `tx` | on that ledger? | on ICP? | provider said |
|---|---|---|---|
| `ly36x-…-cai:12345678` | no | yes | **not confirmed** |
| `12345679` (bare, control) | — | yes | does not pay any matching activation |
| `ly36x-…-cai:80017` | yes | yes | does not pay any matching activation |
| `ly36x-…-cai:81023` (one past VCHF's tip) | no | yes | **not confirmed** |
| `mxzaz-…-cai:9999998` (ckBTC) | no | yes | **not confirmed** |
| `ryjl3-…-cai:12345680` (ICP ledger, PREFIXED) | yes | yes | **not confirmed** |

Two things fall out, and both are load-bearing:

1. The found/not-found boundary moved from the ICP ledger's tip (~38.1 M) to **VCHF's own tip**, and
   the same holds for ckBTC. The prefix genuinely selects the ledger.
2. **The prefixed form does NOT work for native ICP.** An index that plainly exists on the ICP ledger
   answers "not confirmed" once prefixed — so the two spellings are both required and neither
   generalises. dpay encodes exactly this in `ocpIcTxId` (`app/lib/opencryptopay.ts`), and the two
   e2e flows assert one spelling each on the wire (111 bare ICP, 113 prefixed VCHF).

It also explains the two distinct errors: a *nonexistent* index answers "not confirmed in blockchain
InternetComputer", while an index that *exists on the ledger being consulted* but is not their
payment answers "does not pay any matching activation".

### What the acceptance test added

The free probes above prove ledger selection but deliberately cannot prove acceptance. Real paid
orders closed BOTH halves on 2026-09-05: native ICP block `38190401` (bare index, order `2609`) and
VCHF block `81062` (submitted `ly36x-…-cai:81062`, order `2610`) were each accepted by DFX and each
completed its shop order. Details and exact evidence: "Live acceptance proof" below. Flow 113 still
pins the prefixed wire spelling, and the free probe still guards the ledger-selection rule.

## Trust model — read before writing the parser

Verified: the example QR's `lightning` parameter bech32-decodes (hrp `lnurl`) to exactly
`https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e`.

**A scanned LNURL can name ANY host.** Nothing in the standard binds it to a known provider, so a
hostile sticker over a real checkout's QR points the wallet at an attacker's server, which then supplies
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
- **Require `https` on the `callback` URL too, not just the scanned one.** They are different
  strings from different sources: the scanned URL is what the user pointed the camera at, while
  `callback` arrives inside the provider's JSON body and is therefore controlled by whoever answered
  the first request. It is also the URL the transaction id gets reported to. A hostile or downgraded
  callback is a second, independent hole.

## Quote lifetime

300 seconds exactly, measured across repeated fetches. Every `GET` of the payment details mints a
**new** quote id; the previous one stays valid until used or expired. Matches dpay's existing ~5min
request expiry, so no new timing model is needed.

## Receiving through DFX (measured)

A full merchant API exists (`/v1/paymentLink*`), but `POST /v1/paymentLink` requires `bearer` auth
**and** a `routeId` — a sell route, i.e. a bank IBAN. DFX settles merchant proceeds as **fiat to a
bank**. So accepting via DFX means merchant onboarding plus KYC, and a self-payment round trip costs
1.99% sell plus fees and takes days. Not a test loop.

dpay hosting its own provider endpoint instead is the milestone:
[`2026-09-02-merchant-side-plan.md`](2026-09-02-merchant-side-plan.md).

## Provider risk

- `github.com/DFXswiss/api` now 404s — the reference implementation went private. "Everything is
  open source" is stale.
- The swagger (`https://api.dfx.swiss/swagger-json`, 194 paths) declares **no query parameters** for
  `/v1/lnurlp/tx/{id}`, so there is no machine-readable contract for the submission call. The README
  is the only documentation and it is wrong twice — and it does not mention the `tx` spelling at all,
  which is the one undocumented detail that has actually cost money here. That rule reached dpay by
  email, so it can change by email too: re-measure with the free probe before trusting it again.
- The standard is open; in practice DFX is the only provider. Treat provider identity as
  configuration, not a constant.

## Live acceptance proof

Everything up to consent was proven as of 2026-09-02: `just live-ocp` drives the shipped app against
this checkout and lands on a review carrying the live price, the full destination, the provider host and
the countdown — so the scan, both provider reads, the parser, the destination checks and the review
screen are all confirmed against the real thing, not against a fixture.

**Native ICP acceptance is now proven with real money.** On 2026-09-05 a freshly built dpay app on a
physical phone resolved the DFX Shop charge for WooCommerce order `2609`, showed an explicit review
for EUR `0.01`, and sent exactly `0.00442682 ICP` plus the `0.00010000 ICP` ledger fee. The official
ICP index independently reports block `38190401`, from the phone wallet's account identifier to the
DFX payment account, with the quote memo. The app then submitted bare `tx=38190401` exactly once;
DFX answered accepted, the app rendered Paid, and the shop rendered “Thank you. Your order has been
received.” This closes the previously unproven `/tx` acceptance and credited-sale leg for native ICP.

**The prefixed half is paid-proven too, later the same day (2026-09-05).** The same physical phone
paid DFX Shop order `2610` — EUR `0.01`, payment link `pl_136966f8a5d2aa1d` — in VCHF through the
real app: scan → quote → review → one approval, zero retries. `0.00950150` VCHF plus the `0.0001`
ledger fee moved at VCHF block `81062` (2026-09-05T12:54:42Z, memo `d70430be52464587075e85c904afbd79`,
quote `plq_2f35197812d4c97c`) to the same DFX route address `ygf2v-…-4ae`. The app submitted the
ledger-prefixed `ly36x-…-cai:81062` exactly once; DFX answered accepted, and the payment-link API now
returns HTTP 409 "Payment complete" for the link. The phone held exactly `0.02` VCHF and holds
`0.0103985` after — the arithmetic is exact. Both tx-id spellings are therefore live-proven with
paid, credited orders: bare for native ICP (`2609`), prefixed for every other ICRC ledger (`2610`).
