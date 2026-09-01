# OpenCryptoPay — adversarial review, 2026-09-01

Findings from a hostile read of `9a84198..8966032`, ranked by what they cost the user. This file is
the fix ledger; once a row is fixed the commit is the record, and the row says which commit.

Measured provider behaviour: [`2026-09-01-opencryptopay-findings.md`](2026-09-01-opencryptopay-findings.md).

## The shape of the danger

Funds move irreversibly **before** the provider is told, and there is exactly one chance to tell it.
So the ranking below is not by how wrong the code is — it is by how much money a user loses when it
goes wrong, and whether they can recover.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | HIGH | The `/cb/` segment check that decides whether a proof is reportable at all runs *after* the transfer. A callback with no `/cb/` means funds move and the provider is never told — no request is even issued. | fixed — `de97bde` |
| 2 | HIGH | No minimum-remaining-time guard. The only deadline check asks "has it already expired". Worst-case wall clock after Approve is ~100 s (IC) / ~76 s (SOL), so approving at "expires in 30" — exactly what the countdown invites — spends the one-shot against a dead quote. | fixed — `de97bde` |
| 3 | HIGH | An `unknown` IC transfer discards `prepareTransfer`'s handle. The block index is still obtainable by one more `pollTransfer`, and `pollTransfer` is already exported and idempotent — the app throws away the only claim the user has, turning the recoverable case into the unrecoverable one. | fixed — `de97bde` |
| 4 | MED-HIGH | Machine refusal codes render as user copy — the Pay screen literally shows `malformed-details`. Violates the module's own stated rule, the founder instruction rule, and i18n. A test *pins* this. | fixed — `709a7ce` |
| 5 | MED | The IC unresolved screen says "awaiting the merchant's confirmation" directly above "the provider refused the proof and the sale was not credited". Two contradictory statements on the user's only record of a lost payment. SolPayMode does not have this bug — a rail divergence. | fixed — `de97bde` |
| 6 | MED | A **definitively failed** Solana transaction is reported as `unknown`, telling the user "don't pay again" when they must. The distinguishing information is in the thrown message and is discarded. Wrong in the dangerous direction. | fixed — `de97bde` |
| 7 | MED | `displayName` is uncapped and unsanitised (only `.trim()`). Newlines render, so a hostile name pushes the real provider-host line, the countdown and the destination off screen — removing the one line that makes the sticker attack answerable. The payment-link path caps the equivalent field at 32 bytes. | OPEN |
| 8 | MED | Unrecognised query parameters in the payment URI are silently dropped, so `…?to=<principal>&subaccount=abcd&amount=1.` is paid to the owner's **default** subaccount. Fail-open in the one place the module advertises fail-closed. | OPEN |
| 9 | MED | `Date.parse` accepts many spellings despite a comment claiming one. `"2026-09-01 14:50:04"` parses as device-local in V8 — up to 14 h of skew, i.e. a long-expired quote believed live. | OPEN |
| 10 | MED | User-facing English literals on the pre-payment error path bypass i18n. | fixed — `709a7ce` |
| 11 | MED-LOW | `paymentId` and `requestedAmount` are computed and never read, and `requestedAmount` gates a hard refusal of the whole payment. Related: the merchant's fiat ask ("CHF 1") is parsed and never shown, so the payer approves `0.0000162 BTC` without seeing what they are being charged. | OPEN — the `paymentId` half went away with `de97bde` (`submitUrl` replaced it and *is* read); `requestedAmount` is still dead, still a hard refusal, still never shown |
| 12 | MED-LOW | The Solana OCP review has no balance gate; the IC one does. Fails safe, but is a rail divergence on a money surface. | OPEN |
| 13 | LOW | Navigating away mid-flight drops the `unresolved` message — the block index that is the user's sole proof — into a no-op `setState`. Pre-existing pattern, materially worse here. | OPEN |
| 14 | LOW | The review shows the *scanned* host, but the proof is sent to the *callback* host, which is a different string from a different source and may differ. | OPEN |
| 15 | HIGH | Found after this review, as the mirror of #3: an indefinite **Solana** transfer discarded `sendSol`'s broadcast signature, so a broadcast-then-confirm-timeout — money on chain, provider never told — was unrecoverable on that rail. | fixed — uncommitted at the time of writing; replace with the hash on commit |

## Verified clean (do not re-litigate without new evidence)

Hand-traced and found correct: the bech32 decode (BIP-173 polymod, HRP pinning, mixed-case
rejection, padding check, bit accounting); decimal handling (money never touches `number`, exponent
expansion shifts digits without rounding, `parseDecimalToUnits` is the only converter and the
lenient `toUnits` is correctly absent, negatives/NaN/Infinity/>u64/zero all refuse, step-2 and
step-3 amounts compared in canonical raw units); destination integrity (ledger pinned to the
selected asset via `ledgerToCurrency`, same core validators as every other destination, Solana USDC
refused by name with a second lock); the one-shot discipline (exactly one fetch, no loop, no caller
wraps it, reached only on `settled` with a non-empty reference, 2xx-with-unreadable-body resolves to
`unknown` not `accepted`); the second-scan race; and `classifyScan`'s link → OCP → address ordering.
