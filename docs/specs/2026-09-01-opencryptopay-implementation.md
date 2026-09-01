# OpenCryptoPay — implementation plan

Measured behaviour of the provider: [`2026-09-01-opencryptopay-findings.md`](2026-09-01-opencryptopay-findings.md).
That file is the authority for anything the provider does; this file does not restate it. Read it
first — the public README is wrong twice and the loss path is non-obvious.

## Scope

**In:** paying an OpenCryptoPay till from dpay, on the `InternetComputer` method (ckBTC, VCHF, ICP)
and the `Solana` method for **native SOL only**.

**Deliberately out, with reasons:**

- **Solana USDC.** The provider's URI carries no `spl-token` parameter and it is unresolved whether
  the address is the owner or the associated token account. Guessing sends real money to a wrong or
  unspendable account. Blocked pending an answer from DFX — the code must refuse it by name, not
  silently omit it.
- **ckUSDC / ckETH.** Not accepted by the provider. Refuse with the reason.
- **Receiving** (dpay as an OCP merchant). Needs merchant onboarding and a bank IBAN; assessed in
  the findings doc.
- **Any offline variant.** Impossible — the payer must be online.

## Where this lives, and why not in the Rust core

The core owns money- and protocol-critical logic. This is deliberately **app-level TypeScript**, on
the same reasoning that keeps the SOL rail app-scoped:

- The bech32 decode yields a **URL**, not a value or a signature. Getting it wrong yields a failed
  fetch, not a wrong payment.
- Everything that *is* money-critical already goes through the core: the destination is validated by
  `icp_validate_principal` / `icp_validate_icrc_account`, the transfer is built and signed by
  `prepareTransfer` (`app/services/rail.ts`), and the amount conversion uses the existing
  `app/lib/amount.ts` helper.

So this adds **no new signing path and no new wire format**. It must not touch the canister, the
relay, the facade, `dpay-core`, or the 132-byte wire. If an implementation seems to need to, stop
and escalate.

## Unit A — `app/lib/opencryptopay.ts` (pure, no I/O)

Total functions, no throwing for expected-invalid input — return a discriminated refusal so the
caller can name the reason on screen (founder rule: useful practical instructions on every step).

```ts
/** bech32 (LUD-01). Verifies the checksum — a damaged QR must never resolve to a different host. */
export function decodeLnurl(s: string): {ok: true; url: string} | {ok: false; reason: string}

/** Recognise an OCP code. Accepts a bare `LNURL1…` string or any URL carrying a `lightning` query
 *  param. Requires the decoded URL to be https. Returns the provider API URL + its host, which the
 *  review screen MUST display. */
export function parseOcpScan(raw: string): {ok: true; apiUrl: string; host: string} | {ok: false; reason: string}

/** `icp:<ledger>/transfer?to=<principal>&amount=<decimal>`. `amount` may be `1.` — a trailing bare
 *  decimal point. Does NOT validate the principal; the caller runs the core validator. */
export function parseIcpUri(uri: string): {ok: true; ledger: string; to: string; amount: string} | {ok: false; reason: string}

/** `solana:<address>?amount=<decimal>`. */
export function parseSolanaUri(uri: string): {ok: true; to: string; amount: string} | {ok: false; reason: string}

/** Narrow the provider's step-2 JSON. Rejects anything missing quote/callback/transferAmounts. */
export function parsePaymentDetails(json: unknown): {ok: true; details: OcpDetails} | {ok: false; reason: string}

/** Which of the provider's offers this wallet can actually pay, given the assets the user holds.
 *  Returns both payable offers AND named refusals, so the UI can say WHY an asset is unavailable
 *  instead of silently hiding it. */
export function selectPayableOffers(details: OcpDetails, catalog: …): {payable: OcpOffer[]; refused: Array<{asset: string; method: string; reason: string}>}
```

Types: `OcpDetails` carries `paymentId`, `quoteId`, `quoteExpiresAt` (epoch ms), `callbackUrl`,
`merchantName`, `requestedAmount {asset, amount}`, `transferAmounts[]`. Mark provider-supplied
display strings clearly as claimed — e.g. name the field `claimedMerchantName`.

**Refusal reasons must be specific enough to render**: `'solana-usdc-unsupported'`,
`'asset-not-accepted'`, `'quote-expired'`, `'bad-checksum'`, `'not-https'`, `'unknown-method'`.

## Unit B — `app/services/opencryptopay.ts` (I/O)

Uses the app's existing HTTP helper — do not introduce a second fetch wrapper.

```ts
export async function fetchPaymentDetails(apiUrl: string): Promise<
  | {kind: 'ok'; details: OcpDetails}
  | {kind: 'no-pending'; claimedMerchantName?: string}   // provider 404 body, still useful on screen
  | {kind: 'error'; message: string}>

export async function fetchTransferUri(details: OcpDetails, method: string, asset: string): Promise<
  | {kind: 'ok'; uri: string; expiresAt: number}
  | {kind: 'error'; message: string}>

/** ONE-SHOT. See the findings doc's loss path — a failed call burns both the quote and the tx id,
 *  so this MUST NOT retry, and an indefinite answer is `unknown`, never a failure. */
export async function submitProof(
  details: OcpDetails, method: string, asset: string, txId: string,
): Promise<
  | {kind: 'accepted'}
  | {kind: 'rejected'; message: string}   // definitive provider refusal (HTTP 4xx with a body)
  | {kind: 'unknown'; message: string}>   // timeout / transport / unparseable — funds may be spent
```

`submitProof` must be the only place that calls `/tx`, must take a generous timeout, and must never
be wrapped in a retry by any caller. Add a comment saying so at the call site too.

## Unit D — supporting helpers (no OCP knowledge; independently useful)

**D1. `ledgerToCurrency`** in `app/config/catalog.ts`. The reverse lookup does not exist today — the
only ledger-string comparison anywhere is `isNativeIcpLedger` in `app/lib/destination.ts`. OCP names
a **ledger principal**; dpay indexes by **currency id**. Add the named helper beside the other
derived accessors and use it; do not scatter `catalog.find(c => c.ledger === …)` at call sites.
Principal comparison must be exact-string against the canonical text form.

**D2. i18n.** New message group `pay.ocp` in `app/i18n/domains/en/pay.ts` (type block first, value
block second, per house style), plus the same keys in `de`, `es`, `fr` — `tsc` fails otherwise and
there is no runtime fallback by design. One key per refusal reason from Unit A, each naming the
user's next action (founder rule 2026-08-29). `pay.link` in the same file is the model to follow.

## Unit C — wiring

**Which component handles an OCP code.** `PayMode.tsx` (IC) and `SolPayMode.tsx` (Solana) are
alternative mounts chosen by the active asset (`Wallet.tsx:840-857`). An OCP till offers many
assets, so **the user's currently selected asset picks the one we pay with**, and each component
handles only its own family. That is the same-surface rule satisfied, not bypassed: one camera, one
gesture, per-rail execution. If the selected asset is not on the merchant's list, refuse and name
the assets that ARE, telling the user to switch asset in Balances.

**Hook point.** `classifyScan` (`app/lib/scan.ts:41`) gains one variant, e.g.
`{kind: 'opencryptopay'; apiUrl: string; host: string}`. Its module header's ordering rule is
load-bearing and must be preserved: the rail's strict codec answers first, this is the second
opinion. Handle the new variant in `onNotARequest` (`PayMode.tsx:151`) and its Solana twin
(`SolPayMode.tsx:198`). Do not touch the first branch of `onRequestString`.

**Review.** Extend the existing review render (`PayMode.tsx:418-471`, the `intent.source === 'link'`
branch) rather than adding a second review surface. `PayIntent` (`app/lib/types.ts:72-82`) gains
`'ocp'` to its `source` union. The review must additionally show the **provider host** and the
**quote countdown**, and must mark the merchant name as claimed (`review-claimed` already exists).
Never auto-sign — the link path's `prefillIntent` handling (`PayMode.tsx:172-183`) is the precedent:
it explicitly does not auto-sign, unlike the wire path.

**Execution order — binding, see the findings doc's loss path.**
1. Fetch the quote as late as possible (on entering review).
2. On Approve: `prepareTransfer` → `submitTransfer` and get a **settled** `RailOutcome` with a real
   block index. A `rejected` or `unknown` outcome here means STOP — never call `/tx`.
3. Only then `submitProof(...)`, **once**.
4. Map the result: `accepted` → paid; `rejected` → the provider refused *after* funds moved, so show
   the block index and say the merchant must be contacted; `unknown` → pending with the block index.
   Never render `unknown` as paid or as failed.

**Amounts.** Use `parseDecimalToUnits` (`app/lib/amount.ts:70`), which returns a discriminated
result. Do **not** use `toUnits` (`app/lib/format.ts:191`) — it is the lenient UI wrapper and returns
`'0'` on bad input, which here would be a money bug.

**Every refusal names the next action** (founder rule 2026-08-29).

## Testing

- Unit tests per module, positive **and** negative paths, no coverage overlap with existing suites.
- The one-shot discipline needs an explicit regression test: a `submitProof` that times out must
  return `unknown` and must issue exactly **one** HTTP request. Assert the request count.
- Golden-parse the real recorded provider responses in the findings doc (including `amount=1.`).
- e2e flow against the offline harness — no test may contact the live provider. Flows are
  auto-discovered from `e2e/tests/NN-name.mjs` exporting `run()` + `meta`; **next free number is
  111**. Closest precedents: `109-scan-link-and-address.mjs` (scan-fallback classification),
  `103-pay-link-refused.mjs` (refusal copy), `49-deeplink-request.mjs` (link → review). The camera
  seam is `window.__DPAY_TEST_SCAN(payload)` after `armPayScan(driver)`.
- No test spends money. The live end-to-end payment is a separate, founder-approved step.
